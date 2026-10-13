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
 * 没有凭据**不是**失败：那时它照样注册设置页的 RPC 命名空间——操作者要能把凭据填进去，
 * 而页面正是他填的地方。拨号失败同理：失败是页面上的读数（`LiveQqBot.failure`），不是
 * 一个抛出去的异常——一个激活失败的插件没有 RPC 命名空间，能修它的那个页面会先死掉。
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
  pluginConfig as pluginConfigKey,
  pluginRpc as pluginRpcKey,
  sessions as sessionsKey,
  sessionsRoot,
  type Context,
  type Plugin,
  type PluginPageDescriptor,
} from '@noa/core';
import { runCommandText } from '@noa/plugins';
import { AccessGate, mintPairingCode, type AccessPolicy, type AccessTier } from './access.js';
import { BindingsStore } from './bindings.js';
import { QqOutbox } from './outbox.js';
import { localMediaInText, mediaTypeOf } from './media.js';
import { registerSendFileTool } from './send-file-tool.js';
import { PeerTurns, type RemoteAnswer, type RemoteCommandSeat } from './peers.js';
import { probeQqBotConnection } from './probe.js';
import { createQqBotChannel, type QqBotChannel } from './runtime.js';
import { parseRemoteCommand, remoteBypassesQueue, splitSlash } from './remote-parse.js';
import {
  isQqBotSettingKey,
  qqBotCredentialProblem,
  qqBotPage,
  type QqBotPageState,
  type QqBotSettingKey,
  type QqBotSettings,
} from './settings.js';
import type { Peer } from './types.js';

/** 行 id，也是 RPC 命名空间与每一条错误/日志里的名字（一个身份，一处定义）。 */
export const QQ_BOT_PLUGIN_NAME = '@noa/channel-qq';

/** 这一行的设置，也就是 `Config` 校验的形状。 */
export interface QqBotPluginConfig {
  /** 开放平台机器人的 AppID。 */
  appId?: string;
  /** AppSecret；可以是 `{env:NAME}` 引用。 */
  clientSecret?: string;
  /**
   * 已配对的 QQ 身份（群里是成员 openid，私聊是用户 openid）。
   *
   * Written by the pairing flow (`/pair <配对码>` in a private chat, the code
   * shown on this row's own settings page) and by nothing else. Empty means the
   * channel answers nobody but the pairing hint — a chat window is a public input
   * surface, so "unconfigured" must mean "nobody", never "everybody".
   */
  owners?: string[];
  /**
   * The strongest permission tier a QQ peer may set for its own conversation.
   *
   * A ceiling, not a default: the peer may always choose a lower tier, and one
   * that asks for more is refused with that fact stated. Keep it below whatever
   * the operator granted locally — the point of driving a machine from a chat
   * window is that a stolen phone is not a stolen keyboard.
   */
  maxTier?: string;
  /**
   * The standing enrollment secret (see `access.ts`).
   *
   * Persisted because it must survive a restart: a headless server has no settings
   * page, so the console is the only channel that can carry it to the operator, and
   * a secret that vanished on reboot would lock them out of their own machine.
   */
  pairingCode?: string;
}

/** The tiers a `maxTier` may name, mirroring the kernel's approval modes. */
export const QQ_BOT_TIERS = ['read-only', 'auto-edit', 'full'] as const;

/**
 * Both credential fields are optional and that is load-bearing: a row with no
 * credentials still activates (it has a settings page to fill in). What CANNOT be
 * refused here is an unknown key — a typo would look saved and do nothing.
 */
export const Config = objectConfig<QqBotPluginConfig>({
  appId: { type: 'string' },
  clientSecret: { type: 'string' },
  owners: { type: 'string[]' },
  maxTier: { type: 'string', oneOf: QQ_BOT_TIERS },
  pairingCode: { type: 'string' },
});

/** 一次 `action` 的答复面（设置页的「测试连接」按钮读它）。 */
export interface QqBotActionResult {
  ok: boolean;
  message?: string;
  descriptor?: PluginPageDescriptor;
}

/** 本进程这一档激活里跑着的通道。 */
interface LiveQqBot {
  readonly channel: QqBotChannel;
  /** 拨号在飞（设置页据此说「正在连接」而不是「失败」）。 */
  connecting: boolean;
  /** 最近一次拨号失败的原因；成功即消失。 */
  failure?: string;
}

/**
 * 本进程正在跑的通道，供 surface 读。
 *
 * `noa` 这个 surface 只剩「认领 argv 并常驻」，但它必须能如实回答「通道到底
 * 起来了没有」：凭据没填、行没开时它应当启动失败并说明，而不是安静地挂着。所以激活时
 * 在这里登记、fiber 卸载时撤掉——这是**读**，不是启动路径：谁拨号永远只有 fiber 一个答案。
 */
let activeChannel: QqBotChannel | undefined;

/** 本进程此刻在跑的通道；关闭的行或没凭据的行都是 undefined。 */
export function runningQqBotChannel(): QqBotChannel | undefined {
  return activeChannel;
}

/**
 * The running activation's access readings, for a surface with no settings page.
 *
 * `noa` is the HEADLESS deployment: there is no Web UI, so the console is
 * the only place an enrollment secret can reach its operator. Printing it is the
 * difference between "deploy it and message it" and "edit a config file, guess an
 * id format, restart" — which is why this is a reading the surface asks for rather
 * than a `console.log` inside the plugin (the plugin does not own the console).
 */
export interface QqBotAccessReading {
  /** The standing enrollment secret, or undefined when enrollment is closed. */
  pairingCode(): string | undefined;
  /** The QQ identities currently bound. */
  owners(): readonly string[];
}

let activeAccess: QqBotAccessReading | undefined;

/** 本进程此刻的授权读数；行关着或没凭据时 undefined。 */
export function runningQqBotAccess(): QqBotAccessReading | undefined {
  return activeAccess;
}

/** Test seam: clear the process-wide readings (they outlive a fiber by design). */
export function resetQqBotReadings(): void {
  activeChannel = undefined;
  activeAccess = undefined;
}

export const plugin: Plugin<QqBotPluginConfig> = {
  name: QQ_BOT_PLUGIN_NAME,
  manifest: {
    title: 'QQ 机器人',
    description: '腾讯 QQ 机器人开放平台通道：对端消息各跑一轮独立会话，回答按被动回复窗口发回。',
    tier: 'advanced',
    // The row answers a settings `page` (see the namespace below), so it declares
    // one: the settings navigation is drawn from the LIVE roster, and a plugin
    // that stays silent here simply never gets a section — which is what made
    // this channel's credentials unreachable in the real product.
    page: true,
  },
  Config,
  // Everything read with `must` is declared: an absent capability then fails with
  // the service's own name instead of a TypeError deep in a turn. The optional
  // reads (`execution-environment`, `llm`) are deliberately NOT declared — they
  // only enrich `/status`, and requiring them would refuse a headless assembly
  // that is otherwise perfectly able to run this channel.
  inject: [pluginRpcKey, pluginConfigKey, sessionsKey, toolsKey],
  apply: (ctx: Context, config: QqBotPluginConfig): void => {
    const settings: QqBotSettings = {
      ...(config.appId !== undefined ? { appId: config.appId } : {}),
      ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
      ...(config.owners !== undefined ? { owners: [...config.owners] } : {}),
      ...(config.maxTier !== undefined ? { maxTier: config.maxTier } : {}),
      // The stored enrollment secret MUST be read back: `ensurePairingCode` below
      // mints one only when the row carries none, and the code it mints is written
      // straight back to this row's config. Leaving it out of `settings` made every
      // activation believe there was no code, mint a fresh one, and write it —
      // which re-rostered the row, which re-ran `apply`, which minted again: an
      // endless write/reload loop for any row with usable credentials.
      ...(config.pairingCode !== undefined ? { pairingCode: config.pairingCode } : {}),
    };
    let live: LiveQqBot | undefined;
    // The chat → session map, loaded once and published as a reading so the
    // surface's banner and this page can say where each conversation lives.
    // Session LOGS themselves follow the kernel's standard date-bucketed layout
    // (`newSessionDir()`) — same kind of nova session as the browser's, so the
    // WebUI switcher lists them; only this state file stays channel-scoped.
    const bindings = new BindingsStore(path.join(sessionsRoot(), 'qqbot', 'bindings.json'));
    // The owners this activation runs with. Mutable because enrollment WRITES it:
    // a newly bound device works now, not after the next restart.
    const gate = new AccessGate();
    let policy: AccessPolicy = {
      owners: [...(settings.owners ?? [])],
      maxTier: tierOf(settings.maxTier),
      ...(settings.pairingCode !== undefined ? { pairingCode: settings.pairingCode } : {}),
    };

    // The one way anything goes OUT (see `outbox.ts`). Late-bound to the channel
    // through `live`, because the channel is built after the orchestrator that
    // already needs to send (approvals and questions go out DURING a turn).
    const outbox = new QqOutbox({
      send: async (peerId, content, msgId, rich) => {
        const sending = live?.channel;
        if (sending === undefined) throw new Error('qqbot: the channel is not running');
        return await sending.send(peerId, content, msgId, rich);
      },
      lastMsgIdOf: (peerId) => live?.channel?.lastMsgIdOf(peerId),
      // 本地媒体：回复里出现真实存在的图片/视频/语音路径时，随文本一起发文件本体。
      // 存在性检查归这一层（outbox 不做 IO），插件已有 fs。
      localMedia: (content) => localMediaInText(content, (candidate) => existsSync(candidate)),
      recall: async (peerId, messageId) => {
        const sending = live?.channel;
        if (sending === undefined) throw new Error('qqbot: the channel is not running');
        await sending.recall(peerId, messageId);
      },
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
      maxTier: () => policy.maxTier,
      // The kernel's live command catalog. Read through the container per call, so
      // a plugin row switched off changes what `/…` means in the chat window at the
      // same moment it changes the browser's menu — no second list here to drift.
      commands: commandSeat(ctx),
      // 审批与提问必须在轮还没结束时**立刻**推出去：它等的那条消息正是这一轮攥着的。
      // 通道迟绑定，因为它建在跑轮子的东西之后（两者互为对方的输入）。
      //
      // Every outbound message goes through this ONE outbox — the reply, the
      // approval/question notices and the progress lines — because the three rules
      // that bite (which `msg_id`, how many replies one inbound message may draw,
      // and who wins when that is spent) are only answerable in one place. See
      // `outbox.ts`.
      notify: (peer, text, rich) => {
        outbox.narrate(peer.peerId, text, rich);
      },
      // 流式卡片**没有接线**：平台的 `stream_messages` 对这台机器长期回「系统繁忙」
      // （50015001），重试耗尽后回落——读者看到的是一张永远收不了口的半截卡片，加一
      // 条重复的完整回复。没有流式，一轮的文本只走「叙述 + markdown 回复」这一条路，
      // 也就是加流式之前的样子。
      //
      // 座位与实现都还在（`peers.ts` 的 `streamText`、`observer.ts`、`stream.ts` /
      // `stream-send.ts` / `stream-fallback.ts`），所以哪天平台正常了，把下面那段接
      // 回来即可；在那之前不接线，就是不发注定被拒的请求、也不让卡片闪一下再被撤回。
      log: (line) => ctx.log('warn', `qqbot: ${line}`),
      // 工具入口：把本地文件发到本会话所在的 QQ 对话（模型不必知道 peerId）。
      sendFile: async (peerId, filePath, caption) => {
        const result = await outbox.reply(peerId, caption, {
          localFile: { fileType: mediaTypeOf(filePath), path: filePath },
        });
        if (!result.ok) throw new Error(result.reason ?? '发送未完成');
      },
      // 正式答案落地后撤掉过程碎片：转录里留下答案，不留脚手架。
      recallNarration: (peer) => {
        outbox.drainRecallable(peer.peerId);
      },
      canAskUser: () => true,
    });
    ctx.effect(() => () => turns.dispose(), 'qqbot peer turns');

    /**
     * Establish the standing enrollment secret.
     *
     * A headless server has no settings page, so the ONLY channel that can carry
     * a secret to its operator is the console — which is why this mints one when
     * none is configured and persists it. Minting rather than refusing is the
     * difference between "deploy it and message it" and "edit a config file, guess
     * an id format, restart".
     *
     * Persisting it is what makes the arrangement durable: the same secret keeps
     * working across restarts and can enroll a second device later. Rotation is an
     * operator's config edit, not an expiry timer.
     */
    const ensurePairingCode = async (): Promise<void> => {
      if (policy.pairingCode !== undefined && policy.pairingCode.length > 0) return;
      const code = mintPairingCode();
      policy = { ...policy, pairingCode: code };
      await ctx.must(pluginConfigKey).setEntry(QQ_BOT_PLUGIN_NAME, { config: { pairingCode: code } });
    };
    activeAccess = {
      pairingCode: () => policy.pairingCode,
      owners: () => policy.owners,
    };
    ctx.effect(() => () => {
      activeAccess = undefined;
    }, 'qqbot access reading');
    // Loaded eagerly: the first inbound message must not race a disk read, and a
    // failure to load is not fatal (it means "no conversations yet").
    void bindings.load().catch(() => undefined);
    // Only when credentials are usable — a row that cannot dial has no operator
    // waiting for a code, and minting one would write config behind their back.
    if (qqBotCredentialProblem(settings) === undefined) {
      void ensurePairingCode().catch((err: unknown) => ctx.log('warn', `qqbot: ${errMessage(err)}`));
    }

    /**
     * The ONE door from a chat message to work.
     *
     * Both the model path and the remote-command path come through here, so the
     * identity decision cannot be made in one and forgotten in the other. An
     * unbound sender gets a sentence telling them what to do; nothing they sent
     * reaches the model, and no session is created for them.
     *
     * `/pair <secret>` is the sole exception, and only in a private chat — see
     * `AccessGate.check`.
     */
    const guarded = async (text: string, peer: Peer): Promise<RemoteAnswer> => {
      const verdict = gate.check(policy, peer.actorId, peer.kind, text);
      switch (verdict.kind) {
        case 'allow':
          return await turns.run(text, peer);
        case 'refuse':
          return { text: verdict.reply };
        case 'paired': {
          // Persist FIRST, then answer: a binding that only existed in memory would
          // be lost on the next restart, and the device would have to enroll again
          // with the same secret — the one-time ceremony this design removes.
          policy = { ...policy, owners: [...policy.owners, verdict.actorId] };
          await ctx.must(pluginConfigKey).setEntry(QQ_BOT_PLUGIN_NAME, {
            config: { owners: [...policy.owners] },
          });
          ctx.log('info', `qqbot: bound a new owner (${policy.owners.length} total)`);
          return { text: verdict.reply };
        }
      }
    };

    /** 描述符：活读数只在通道真的在跑时去问（见 `QqBotChannel.reading`）。
        没有 `saved`：「刚保存过」是一次反馈（`save` 应答的 ok），不是页面的
        一项事实——写进描述符它就会随缓存活过之后的每一次编辑。 */
    const describe = async (shown: QqBotSettings): Promise<PluginPageDescriptor> => {
      const reading =
        live === undefined || live.failure !== undefined
          ? undefined
          : await live.channel.reading().catch(() => undefined);
      const state: QqBotPageState = {
        settings: shown,
        phase: live === undefined ? 'off' : live.failure !== undefined ? 'failed' : live.connecting ? 'connecting' : 'live',
        ...(live?.failure !== undefined ? { failure: live.failure } : {}),
        ...(reading?.botName !== undefined ? { botName: reading.botName } : {}),
        ...(reading !== undefined
          ? {
              stats: {
                received: reading.received,
                replied: reading.replied,
                ...(reading.lastReceivedAt !== undefined ? { lastReceivedAt: reading.lastReceivedAt } : {}),
              },
            }
          : {}),
        ...(policy.pairingCode !== undefined ? { pairingCode: policy.pairingCode } : {}),
        ...(bindings.entries().length > 0 ? { conversations: bindings.entries().length } : {}),
      };
      return qqBotPage(state);
    };

    const runAction = async (payload: unknown): Promise<QqBotActionResult> => {
      const id = textMember(payload, 'id');
      if (id === undefined || id.length === 0) throw new Error('qqbot: "action" needs an "id"');
      if (id === 'rotate') {
        // ROTATION is the revocation path, and it is deliberate rather than
        // automatic: the secret is standing (that is what makes enrollment
        // convenient on a headless box), so the operator — not a timer — decides
        // when it stops working.
        const code = mintPairingCode();
        policy = { ...policy, pairingCode: code };
        await ctx.must(pluginConfigKey).setEntry(QQ_BOT_PLUGIN_NAME, { config: { pairingCode: code } });
        return {
          ok: true,
          message: `已换新配对码 ${code}；旧的立刻失效。在 QQ 里私聊本机器人发送 /pair ${code}`,
          descriptor: await describe(settings),
        };
      }
      if (id === 'forget') {
        // Un-binding every device: the only way to take access away from a phone
        // that is no longer yours.
        policy = { ...policy, owners: [] };
        await ctx.must(pluginConfigKey).setEntry(QQ_BOT_PLUGIN_NAME, { config: { owners: [] } });
        return { ok: true, message: '已解除全部 QQ 绑定；下一次入网需要重新配对。', descriptor: await describe(settings) };
      }
      if (id !== 'test') throw new Error(`qqbot: unknown action "${id}"`);
      // The probe runs on what the operator JUST typed when the page sent fields
      // along (testing before saving is the whole point of the button), and on the
      // stored settings otherwise.
      const candidate = mergeSettings(settings, settingFields(member(payload, 'fields')));
      const problem = qqBotCredentialProblem(candidate);
      if (problem !== undefined) return { ok: false, message: problem, descriptor: await describe(settings) };
      try {
        const gateway = await probeQqBotConnection({
          appId: candidate.appId ?? '',
          clientSecret: candidate.clientSecret ?? '',
        });
        return { ok: true, message: `凭据有效：网关 ${gateway}`, descriptor: await describe(settings) };
      } catch (err) {
        return { ok: false, message: `连接失败：${errMessage(err)}`, descriptor: await describe(settings) };
      }
    };

    // The settings namespace is registered FIRST and unconditionally: this is the
    // door the credentials come in through, so it must exist while they are still
    // missing. It dies with the fiber like everything else — a switched-off row
    // cannot answer, which is exactly what the browser reports.
    ctx.effect(
      () =>
        ctx.must(pluginRpcKey).register(QQ_BOT_PLUGIN_NAME, async (op, payload) => {
          switch (op) {
            case 'page':
              return describe(settings);
            case 'save': {
              const fields = settingFields(requireFields(payload));
              const merged = mergeSettings(settings, fields);
              // Persist through the port, and turn the row ON: saving a settings
              // page the operator just filled in is asking for it to run.
              await ctx.must(pluginConfigKey).setEntry(QQ_BOT_PLUGIN_NAME, {
                enabled: true,
                config: merged,
              });
              // The ceiling may have moved with this save; a peer that was allowed
              // `full` a moment ago must not keep it because the page changed. The
              // enrollment secret is NOT touched here: it is standing by design
              // (rotating it is the explicit `rotate` action), and a save silently
              // invalidating it would strand every device the operator has.
              policy = {
                owners: [...(merged.owners ?? [])],
                maxTier: tierOf(merged.maxTier),
                ...(policy.pairingCode !== undefined ? { pairingCode: policy.pairingCode } : {}),
              };
              return describe(merged);
            }
            case 'action':
              return runAction(payload);
            default:
              throw new Error(`qqbot: unknown operation "${op}"`);
          }
        }),
      `rpc(${QQ_BOT_PLUGIN_NAME})`,
    );

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
        handle: guarded,
      },
      // 新消息 = 新意图：把在跑的那一轮打断，而不是让它排队等完（`/stop` 是同一个
      // 动作的点名版，两者都落在 `AgentSession.abort()`）。
      interrupt: (peer: Peer) => turns.interrupt(peer),
      // The inbound reply shares the outbox with everything else, so the window
      // rule and the per-message allowance have ONE owner.
      reply: { reply: (peerId, content, rich) => outbox.reply(peerId, content, rich) },
      // A plugin has no console owner: FAILURE lines (rich rejected / send
      // failed / recall failed) are diagnostics an operator may need to act on,
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
    const started: LiveQqBot = { channel, connecting: true };
    live = started;
    ctx.effect(() => {
      activeChannel = channel;
      // The dial is async and its failure is a READING, never a throw: see the
      // module header. Re-saving the credentials is the retry path, which is why
      // the reason has to survive as page state rather than as a failed row.
      void channel.start().then(
        () => {
          started.connecting = false;
        },
        (err: unknown) => {
          const message = errMessage(err);
          started.connecting = false;
          started.failure = message;
          // The message already names the channel (`qqbot: …`), so this adds no prefix.
          ctx.log('warn', message);
        },
      );
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
 * 提交的字段并到当前设置上。
 *
 * 空串是「不改」而不是「清空」：密钥字段从不回显，留空是操作者说「密钥照旧」的唯一
 * 办法。未提交的字段**必须跟着走**，因为 `plugin-config` 的 `config` 是整份替换——
 * 少带一个键就等于把它从文件里删掉。代价是：如果配置层已经把 `{env:NAME}` 兑现成了
 * 明文交给我们，这次保存会把那份明文写回文档；只有宿主能保住引用（见交付说明）。
 *
 * The returned value is the WHOLE settings, not just the edited fields: the same
 * object is the save's config patch AND the descriptor the page renders back, so
 * a field the form does not own (the enrolled `owners`, the standing
 * `pairingCode`) has to ride through unchanged — otherwise the write would look
 * like it dropped them and the page would report every device as unbound.
 * @param current - the settings this activation was given.
 * @param patch - the submitted fields.
 * @returns the settings to store.
 */
function mergeSettings(
  current: QqBotSettings,
  patch: Partial<Record<QqBotSettingKey, string>>,
): QqBotSettings {
  const appId = patch.appId?.trim() ?? '';
  const secret = patch.clientSecret?.trim() ?? '';
  const maxTier = patch.maxTier?.trim() ?? '';
  return {
    ...(appId.length > 0 ? { appId } : current.appId !== undefined ? { appId: current.appId } : {}),
    ...(secret.length > 0
      ? { clientSecret: secret }
      : current.clientSecret !== undefined
        ? { clientSecret: current.clientSecret }
        : {}),
    // `maxTier` is one of the page's own fields, so it arrives with every save;
    // carrying the current value when it is absent keeps a synthetic/partial
    // payload from silently lowering the remote cap to the weakest tier.
    ...(maxTier.length > 0 ? { maxTier } : current.maxTier !== undefined ? { maxTier: current.maxTier } : {}),
    // Not form fields: written by the pairing flow, never by this form, so they
    // are preserved rather than derived from `patch`.
    ...(current.owners !== undefined ? { owners: [...current.owners] } : {}),
    ...(current.pairingCode !== undefined ? { pairingCode: current.pairingCode } : {}),
  };
}

/** A configured `maxTier` as the union, defaulting to the WEAKEST tier. */
function tierOf(configured: string | undefined): AccessTier {
  return (QQ_BOT_TIERS as readonly string[]).includes(configured ?? '')
    ? (configured as AccessTier)
    : 'read-only';
}

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

/** `save` 的 payload → 提交的字段；缺 `fields` 是契约违背，点名拒绝。 */
function requireFields(payload: unknown): Record<string, unknown> | undefined {
  const fields = member(payload, 'fields');
  if (fields === undefined) throw new Error('qqbot: "save" needs a "fields" object of strings');
  return fields;
}

/** 提交的字段表 → 已校验的设置；未知键与非法类型都在这里点名。 */
function settingFields(raw: Record<string, unknown> | undefined): Partial<Record<QqBotSettingKey, string>> {
  const out: Partial<Record<QqBotSettingKey, string>> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!isQqBotSettingKey(key)) throw new Error(`qqbot: unknown setting "${key}"`);
    if (typeof value !== 'string') throw new Error(`qqbot: setting "${key}" must be a string`);
    out[key] = value;
  }
  return out;
}

/** One object member of a payload, when it is present and really an object. */
function member(value: unknown, key: string): Record<string, unknown> | undefined {
  const found = plainMember(value, key);
  if (found === undefined || Array.isArray(found)) return undefined;
  return found as Record<string, unknown>;
}

/** One string member of a payload, when it is present and really a string. */
function textMember(value: unknown, key: string): string | undefined {
  const found = plainMember(value, key);
  return typeof found === 'string' ? found : undefined;
}

/**
 * One member of an object-shaped value, without trusting its shape.
 *
 * The payload crosses the plugin boundary as `unknown` on purpose (only this
 * plugin knows what its operations mean), so every read has to survive a hostile
 * or merely wrong shape — an array, a primitive, a missing key.
 */
function plainMember(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}



