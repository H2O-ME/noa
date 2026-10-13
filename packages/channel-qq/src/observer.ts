/**
 * 一轮的观察者：叙述（节流）与流式卡片（逐条消息）在**一个**对象里合流。从 `peers.ts`
 * 拆出：那边讲「谁跑哪一轮」，这里讲「这一轮怎么被讲出来」。两者必须合流的地方在
 * `assistantDone`——流式已把整条文本送上卡片时，纯文本叙述必须让位。
 */
import type { Peer } from './types.js';
import { ProgressRelay } from './progress.js';
import { handleStreamBreak } from './stream-fallback.js';
import { ReplyStreamer } from './stream.js';
import type { TurnObserver } from './turn.js';

/** 观察者要用到的那几件事实（与 `PeerTurnDeps` 的交集，避免整份依赖拖进来）。 */
export interface TurnObserverDeps {
  notify: (peer: Peer, text: string) => void;
  streamText?: (
    peer: Peer,
    text: string,
    state: 1 | 10,
    index: number,
    streamMsgId?: string,
  ) => Promise<{ streamMsgId?: string } | void>;
  /** 卡片中途发不出去时撤掉它，让回落的那条正文成为唯一一份（见 `peers.ts`）。 */
  recallStream?: (peer: Peer, messageId: string) => Promise<void>;
  /**
   * 现在要不要走流式。缺省 = 要。平台会把流式接口整段时间地拒掉，那时继续每轮都试只是
   * 让回复先等几秒重试、还可能让卡片闪一下又被撤回——所以断路器归装配层持有。
   */
  streamGate?: () => boolean;
  /** 一次流式彻底失败（重试耗尽，或根本不可重试）；装配层据此断开断路器。 */
  onStreamBroken?: (err: unknown) => void;
  log?: (line: string) => void;
}

/**
 * 组装这一轮的观察者。谁在什么时候让位是这里的全部内容：
 *  - 流式可用时，每条助手文本边生成边长在一张 markdown 卡片上；
 *  - 流式失败（或没有座位）时，退回预算内的纯文本叙述；
 *  - `assistantDone` 的结论 = 这条已由卡片送达，叙述不再重复它。结论可能是 promise
 *    （收口是网络调用），调用方会等它——乐观地先答「已送达」会在收口失败时把正文吞掉。
 * @param peer - 这一轮服务的对端。
 * @param deps - 通知、流式座位与留痕。
 * @returns 传给 `promptOnce` 的观察者。
 */
export function turnObserver(peer: Peer, deps: TurnObserverDeps): TurnObserver {
  const relay = new ProgressRelay({ send: (line) => { deps.notify(peer, line); } });
  // 流式的 stream_msg_id 是「一条消息」的属性：换消息就换 id，所以它跟着这一轮的
  // 闭包走，而不是存在别处。
  let streamMsgId: string | undefined;
  const streamer = deps.streamText === undefined || deps.streamGate?.() === false
    ? undefined
    : new ReplyStreamer({
        onBroken: (err) => {
          // 卡片 id 在这一刻就作废（这一轮的流到此为止），先取走再交给收尾。
          const card = streamMsgId;
          streamMsgId = undefined;
          handleStreamBreak(err, peer, card, deps);
        },
        sink: async (p) => {
          const res = await deps.streamText?.(peer, p.text, p.state, p.index, streamMsgId);
          const id = (res ?? {}).streamMsgId;
          if (typeof id === 'string' && id.length > 0) streamMsgId = id;
        },
      });
  return {
    tool: (name) => { relay.tool(name); },
    text: (body) => { relay.text(body); },
    ...(streamer !== undefined
      ? {
          delta: (mid: string, chunk: string) => { streamer.feed(mid, chunk); },
          assistantDone: (mid: string, body: string) => streamer.done(mid, body),
        }
      : {}),
  };
}
