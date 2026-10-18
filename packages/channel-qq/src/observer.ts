/**
 * 一轮的观察者：把内核事件变成聊天里的过程叙述。
 *
 * 从 `peers.ts` 拆出：那边讲「谁跑哪一轮」，这里讲「这一轮怎么被讲出来」。
 *
 * **没有流式**。平台有 `stream_messages` 接口，但（一）它对这台机器长期回「系统繁忙」
 * （50015001），（二）Hermes Agent 的 QQ 适配器从不调用它——它的「正在忙」是平台自带的
 * typing 提示，不是逐片消息。于是这里的输出只有一条路：预算内的纯文本叙述，加上最后由
 * 回复座位送出的那一条答案。删掉的那条链（`stream.ts` / `stream-send.ts` /
 * `stream-fallback.ts`）连同「卡片发不出去要撤回」的收尾一起消失，读者不会再看到一条
 * 消息先出现、再被撤走。
 */
import type { Peer } from './types.js';
import { ProgressRelay } from './progress.js';
import type { TurnObserver } from './turn.js';

/** 观察者要用到的那几件事实（与 `PeerTurnDeps` 的交集，避免整份依赖拖进来）。 */
export interface TurnObserverDeps {
  notify: (peer: Peer, text: string) => void;
}

/**
 * 组装这一轮的观察者。
 * @param peer - 这一轮服务的对端。
 * @param deps - 通知座位。
 * @returns 传给 `promptOnce` 的观察者。
 */
export function turnObserver(peer: Peer, deps: TurnObserverDeps): TurnObserver {
  const relay = new ProgressRelay({ send: (line) => { deps.notify(peer, line); } });
  return {
    tool: (name) => { relay.tool(name); },
    text: (body) => { relay.text(body); },
  };
}
