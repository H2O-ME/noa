/**
 * QQ 机器人：一个自持通道的标准插件。
 *
 * 它曾经是个「宿主按名字构造的工厂」——`qqbotPlugin(options)` 拿宿主递来的发送函数，
 * 而入站通道由 surface 侧的桥另建、由 `web-mode.ts` 在启动时拨号。后果就是这个重构
 * 要修的那个 bug：**行关着，通道照跑**（宿主从它留着的候选对象上拨号），以及「保存
 * 了凭据什么都没发生」（启动路径绑在启动时的配置快照上）。
 *
 * 现在按插件协议只有一条路：行开 → `apply` 跑 → 通道在这里建、在这里拨、随 fiber 收
 * （`ctx.effect`）；行关 → 没有 fiber，没有 socket，也没有定时器。凭据来自**它自己
 * 的 config**（行 `plugins.entries[].config`，由上面的 `Config` 校验），从不来自宿主
 * 递进来的对象。
 *
 * 没有凭据**不是**失败：那时它照样激活，只是不拨号——`noa --check` 读 `runningQqBotChannel()`
 * 与 `qqBotCredentialProblem` 如实报出「为什么没拨」。拨号失败同理：失败是一条日志，
 * 不是一个抛出去的异常。
 *
 * 模块**无导入副作用**：行关着时插件树也要 import 它来读 manifest（见 `plugin-tree.ts`）。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';

import {
  errMessage,
  tools as toolsKey,
  commands as commandsKey,
  executionEnvironment as executionEnvironmentKey,
  llm as llmKey,
  objectConfig,
  pricing as pricingKey,
  modelControl as modelControlKey,
  modelDefaults as modelDefaultsKey,
  sessions as sessionsKey,
  sessionsRoot,
  transcription as transcriptionKey,
  type Context,
  type Plugin,
} from '@noa/core';
import { runCommandText } from '@noa/plugins';
import { BindingsStore } from './bindings.js';
import { QqOutbox } from './outbox.js';
import { localMediaInText, mediaTypeOf } from './media.js';
import { registerSendFileTool } from './send-file-tool.js';
import { PeerTurns, type RemoteAnswer, type RemoteCommandSeat } from './peers.js';
import { createQqBotChannel, type QqBotChannel } from './runtime.js';
import { parseRemoteCommand, remoteBypassesQueue, splitSlash } from './remote-parse.js';
import { qqBotCredentialProblem, type QqBotSettings } from './settings.js';
import type { Peer, TurnInput } from './types.js';

/** 行 id，也是每一条错误/日志里的名字（一个身份，一处定义）。 */
export const QQ_BOT_PLUGIN_NAME = '@noa/channel-qq';

/** 这一行的设置，也就是 `Config` 校验的形状。 */
export interface QqBotPluginConfig {
  /** 开放平台机器人的 AppID。 */
  appId?: string;
  /** AppSecret；可以是 `{env:NAME}` 引用。 */
  clientSecret?: string;
}

/**
 * Both credential fields are optional and that is load-bearing: a row with no
 * credentials still activates (it simply does not dial). What CANNOT be refused
 * here is an unknown key — a typo would look saved and do nothing.
 */
export const Config = objectConfig<QqBotPluginConfig>({
  appId: { type: 'string' },
  clientSecret: { type: 'string' },
});

/**
 * 本进程正在跑的通道，供 surface 读。
 *
 * `noa` 这个 surface 只剩「认领 argv 并常驻」，但它必须能如实回答「通道到底
 * 起来了没有」：凭据没填、行没开时它应当启动失败并说明，而不是安静地挂着。所以激活时
 * 在这里登记、fiber 卸载时撤掉——这是**读**，不是启动路径：谁拨号永远只有 fiber 一个答案。
 */
let activeChannel: QqBotChannel | undefined;

/**
 * 本进程此刻在跑的通道；关闭的行或没凭据的行都是 undefined。
 */
export function runningQqBotChannel(): QqBotChannel | undefined {
  return activeChannel;
}

/** Test seam: clear the process-wide reading (it outlives a fiber by design). */
export function resetQqBotReadings(): void {
  activeChannel = undefined;
}

export const plugin: Plugin<QqBotPluginConfig> = {
  name: QQ_BOT_PLUGIN_NAME,
  manifest: {
    title: 'QQ 机器人',
    description: '腾讯 QQ 机器人开放平台通道：对端消息各跑一轮独立会话，回答按被动回复窗口发回。',
    tier: 'advanced',
  },
  Config,
  // Everything read with `must` is declared: an absent capability then fails with
  // the service's own name instead of a TypeError deep in a turn. The optional
  // reads (`execution-environment`, `llm`) are deliberately NOT declared — they
  // only enrich `/status`, and requiring them would refuse a headless assembly
  // that is otherwise perfectly able to run this channel.
  inject: [sessionsKey, toolsKey],
  apply: (ctx: Context, config: QqBotPluginConfig): void => {
    const settings: QqBotSettings = {
      ...(config.appId !== undefined ? { appId: config.appId } : {}),
      ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
    };
    let live: QqBotChannel | undefined;
    // The chat → session map, loaded once so a restart resumes the same
    // conversations. Session LOGS themselves follow the kernel's standard
    // date-bucketed layout (`newSessionDir()`) — same kind of nova session as the
    // browser's, so the WebUI switcher lists them; only this state file stays
    // channel-scoped.
    const bindings = new BindingsStore(path.join(sessionsRoot(), 'qqbot', 'bindings.json'));

    // The one way anything goes OUT (see `outbox.ts`). Late-bound to the channel
    // through `live`, because the channel is built after the orchestrator that
    // already needs to send (approvals and questions go out DURING a turn).
    const outbox = new QqOutbox({
      send: async (peerId, content, msgId, rich) => {
        const sending = live;
        if (sending === undefined) throw new Error('qqbot: the channel is not running');
        return await sending.send(peerId, content, msgId, rich);
      },
      lastMsgIdOf: (peerId) => live?.lastMsgIdOf(peerId),
      // 本地媒体：回复里出现真实存在的图片/视频/语音路径时，随文本一起发文件本体。
      // 存在性检查归这一层（outbox 不做 IO），插件已有 fs。
      localMedia: (content) => localMediaInText(content, (candidate) => existsSync(candidate)),
      log: (line) => ctx.log('warn', line),
    });

    const turns = new PeerTurns({
      sessions: ctx.must(sessionsKey),
      // 会话落点用内核默认（标准日期桶）：本通道开的会话与浏览器的同布局同清单，
      // WebUI 切换器照常见到。不再传 `sessionDir` 自设隔离目录。
      // 接力清单的取处：这台机器上的**每一段会话**，不只是本通道自己的。
      catalogDir: sessionsRoot(),
      bindings,
      rootDir: () => ctx.get(executionEnvironmentKey)?.rootDir(),
      model: () => ctx.get(llmKey)?.model,
      // The kernel's live command catalog. Read through the container per call, so
      // a plugin row switched off changes what `/…` means in the chat window at the
      // same moment it changes the browser's menu — no second list here to drift.
      commands: commandSeat(ctx),
      // 模型价格表：容器里有就接给 `/usage`，没有就缺省（读数只报 token 数并注明未配价）。
      // `get` 而不是 `must`：部署方没写 `pricing` 是受支持的状态，不是启动失败——
      // 与转写接缝同一条纪律。
      ...(() => {
        const table = ctx.get(pricingKey);
        return table === undefined ? {} : { pricing: table };
      })(),
      // 模型座位，同样是「容器里有才接」：没有模型目录就没有切换座位（`/model` 会
      // 如实说本部署的模型写在 config.json 里），没有可写配置就没有「写默认」座位
      // （`/model default` 会说切了但默认没写成）。两个座位分开，是因为它们本来就是
      // 两种权威：一个改这个进程，一个改下次启动。
      ...(() => {
        const control = ctx.get(modelControlKey);
        return control === undefined ? {} : { models: control };
      })(),
      ...(() => {
        const defaults = ctx.get(modelDefaultsKey);
        return defaults === undefined ? {} : { modelDefaults: defaults };
      })(),
      // 审批与提问必须在轮还没结束时**立刻**推出去：它等的那条消息正是这一轮攥着的。
      // 通道迟绑定，因为它建在跑轮子的东西之后（两者互为对方的输入）。
      //
      // Every outbound message goes through this ONE outbox — the reply, the
      // approval/question notices and the progress lines — because the three rules
      // that bite (which `msg_id`, how many replies one inbound message may draw,
      // and who wins when that is spent) are only answerable in one place. See
      // `outbox.ts`.
      notify: (peer, text, rich, kind) => {
        const result = outbox.narrate(peer.peerId, text, rich, kind);
        // 被拒不再是无声的。线上那次事故里没有任何一行日志指向真正的原因：卡片被额度
        // 挡下、调用方丢掉返回值，读者只看到「三分钟后按超时拒绝」。交互被拒是 warn
        // （这一轮正停在它上面），叙述被拒是 debug（额度按设计生效，别淹日志）。
        if (!result.ok) {
          const line = `qqbot: ${kind ?? 'narration'} not sent to ${peer.peerId}: ${result.reason ?? 'unknown reason'}`;
          ctx.log(kind === 'interaction' ? 'warn' : 'debug', line);
        }
        return result;
      },
      // 没有流式座位：整条链（`stream.ts` / `stream-send.ts` / `stream-fallback.ts`、
      // `protocol.sendStreamC2C`、`turn.ts` 的 delta/assistantDone 与 `streamed` 判定）
      // 已经删掉。理由有两条，任一条都够：
      //
      //  - 平台的 `stream_messages` 对这台机器长期回「系统繁忙」（50015001），重试耗尽
      //    后回落——读者看到的是一张永远收不了口的半截卡片，加一条重复的完整回复；
      //  - Hermes Agent 的 QQ 适配器从不流式（`gateway/platforms/qqbot/adapter.py` 里
      //    没有任何 `stream_messages` 调用），它的「正在忙」是平台自带的 typing 提示。
      //
      // 现在一轮的输出只有两条路：预算内的纯文本叙述，和最后由回复座位送出的那一条答案。
      // 工具入口：把本地文件发到本会话所在的 QQ 对话（模型不必知道 peerId）。
      sendFile: async (peerId, filePath, caption) => {
        const result = await outbox.reply(peerId, caption, {
          localFile: { fileType: mediaTypeOf(filePath), path: filePath },
        });
        if (!result.ok) throw new Error(result.reason ?? '发送未完成');
      },
      canAskUser: () => true,
    });
    ctx.effect(() => () => turns.dispose(), 'qqbot peer turns');

    // Loaded eagerly: the first inbound message must not race a disk read, and a
    // failure to load is not fatal (it means "no conversations yet").
    void bindings.load().catch(() => undefined);

    /**
     * The ONE door from a chat message to work.
     *
     * Both the model path and the remote-command path come through here, so the
     * two cannot drift apart. There is deliberately NO access gate: this is a
     * single-operator deployment, and the safety net is the permission tier
     * (`auto` = a reviewer model, a human only when it is unsure) rather than an
     * enrollment ceremony. Anything a peer can reach, the model may be asked to
     * do — which is the point of a bot you run for yourself.
     */
    const guarded = async (turn: TurnInput, peer: Peer): Promise<RemoteAnswer> => await turns.run(turn, peer);

    if (qqBotCredentialProblem(settings) !== undefined) return;

    const channel = createQqBotChannel({
      appId: settings.appId ?? '',
      clientSecret: settings.clientSecret ?? '',
      // Both entry points go through the SAME guard, so authorization cannot be
      // enforced on one path and forgotten on the other.
      brain: guarded,
      // 遥控指令走串行队列**之外**的旁路：一轮可能停在审批上等人回答，而答复要排队的话
      // 就会永远排在自己所等的那一轮后面（死锁）。`claim` 用同一个纯解析器判定，
      // 且只放行**读与解阻塞**那几条（见 `remoteBypassesQueue`）：提档也算解阻塞——
      // 轮停在审批上时，「别再问了」正是用户从手机上要的出路；开新会话、内核目录
      // 命令仍须排在队列里，不能与正在跑的一轮并发。
      //
      // 非指令的普通话也在旁路之内，但**只在这个对端正停在一个提问上时**：那时它是
      // 答复（自然语言即自由回答），而提问把这一轮停在了原地——排队答复就是让它等
      // 自己。不在提问时它仍是新指令，照旧入队。
      remote: {
        claim: (text, peer) => {
          const parsed = parseRemoteCommand(text);
          if (parsed.command !== undefined) return remoteBypassesQueue(parsed.command);
          return splitSlash(text) === undefined && turns.awaitingQuestion(peer);
        },
        // 遥控是文本：附件消息永远不会走到这里（入站侧已按有无附件分流）。
        handle: (text, peer) => guarded({ text }, peer),
      },
      // 新消息 = 新的意图，但它**插进**在跑的那一轮，而不是把它打断：一轮里可能已经
      // 跑过 bash、写过文件，打断等于把已经发生的副作用留在原地却不再解释它们。真要
      // 立刻停下，`/stop` 是点名的那条路（它走旁路，仍落在 `AgentSession.abort()`）。
      interject: (turn, peer) => turns.interject(turn, peer),
      // 语音转写：容器里有就接上，没有就缺省（语音消息降级为「未配置转写」）。
      // `get` 而不是 `must`：未配置 `sttModel` 是受支持的状态，不是启动失败。
      ...(() => {
        const transcriber = ctx.get(transcriptionKey);
        return transcriber === undefined
          ? {}
          : { transcribe: (bytes: Uint8Array, hints: { mediaType?: string; filename?: string }) => transcriber.transcribe(bytes, hints) };
      })(),
      // The inbound reply shares the outbox with everything else, so the window
      // rule and the per-message allowance have ONE owner.
      reply: { reply: (peerId, content, rich) => outbox.reply(peerId, content, rich) },
      // A plugin has no console owner: FAILURE lines (rich rejected / send
      // failed) are diagnostics an operator may need to act on,
      // so they go out at `warn` — `info` is NOA_LOG-gated and would bury the
      // reason the panel shows plain text where a card should be. Routine
      // receipts (`…: sent`, `gateway identified/resumed`) stay `info`: noise
      // on a healthy channel, available under NOA_LOG when actually debugging.
      log: (line) =>
        ctx.log(
          line.endsWith(': sent') || line.startsWith('gateway ') ? 'info' : 'warn',
          `qqbot: ${line}`,
        ),
    });
    live = channel;
    ctx.effect(() => {
      activeChannel = channel;
      // The dial is async and its failure is a LOG, never a throw: see the module
      // header. A failed first dial is not a dead channel either — the gateway
      // retries it on its own backoff, so fixing the credentials and letting the
      // next attempt run is enough. This `catch` is a backstop for a bug elsewhere
      // (an unhandled rejection here would take the process down).
      void channel.start().catch((err: unknown) => {
        // The message already names the channel (`qqbot: …`), so this adds no prefix.
        ctx.log('warn', errMessage(err));
      });
      return () => {
        if (activeChannel === channel) activeChannel = undefined;
        channel.stop();
      };
    }, 'qqbot channel');

    // ONE tool, and it is deliberately NOT the old `qqbot_send` — see
    // `send-file-tool.ts` for what it is for and why its target is fixed to the
    // QQ conversation this session belongs to.
    registerSendFileTool(ctx, {
      send: (file) => turns.sendFileToCurrentConversation(file),
      rootDir: () => ctx.get(executionEnvironmentKey)?.rootDir() ?? '',
    });
  },
};

export default plugin;

/**
 * The kernel's command catalog, as a seat this package can use.
 *
 * Both halves read the container LIVE, which is the point: the catalog is a
 * property of the loaded plugin rows, so a command must appear in the chat window
 * exactly when its row is loaded and vanish when it is switched off. Caching a
 * name list here would be the same "two tables that can disagree" defect the
 * plugin tree exists to prevent.
 *
 * Execution goes through the host's ONE implementation (`runCommandText`, the
 * same function the browser's command runner uses), so a command cannot behave
 * one way in the UI and another in a chat window.
 * @param ctx - the plugin's context.
 * @returns the seat.
 */
function commandSeat(ctx: Context): RemoteCommandSeat {
  return {
    catalog: () =>
      (ctx.get(commandsKey)?.all() ?? []).map((command) => ({
        name: command.name,
        description: command.description,
      })),
    run: async (name, args) =>
      await runCommandText(
        ctx.get(commandsKey),
        name,
        args,
        ctx.get(executionEnvironmentKey)?.rootDir() ?? process.cwd(),
      ),
  };
}

