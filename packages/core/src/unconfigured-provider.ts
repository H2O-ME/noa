/**
 * 「还没有配置模型端点」的占位 provider。
 *
 * 初次使用必须能启动到设置页，而内核装配需要一个 `ChatProvider`——于是这里给一个
 * **只会拒绝**的实现，而不是把 `provider` 整个变成可选（那会让内核里每一处
 * `provider.stream` 都要处理不存在，把「没配」这个产品状态泄漏成类型噪音）。
 *
 * 定义在 core 而不是某个 surface：cli 与 web 两个装配点都需要它，而 `web` 永远
 * 不 import `cli`（依赖方向门禁）。两份实现会让「没配时说什么」漂移。
 *
 * 拒绝路径必须是 **throw**，不是返回空流：空流会被读成「模型回答了空内容」，而真相
 * 是「你还没配端点」。句子带上可执行的下一步，模型端也就永远不会被问到一个不存在
 * 的端点。
 */
import type { ChatProvider } from './types.js';

/** 未配置端点时显示的那句话（单一出处，每个 surface 共用）。 */
export const NO_PROVIDER_MESSAGE = '尚未配置模型端点：打开设置 → 模型，填写端点地址与密钥后即可开始对话。';

/**
 * A `ChatProvider` that refuses every request with {@link NO_PROVIDER_MESSAGE}.
 * @returns the placeholder, safe to hand to kernel assembly.
 */
export function unconfiguredProvider(): ChatProvider {
  return {
    stream(): AsyncIterable<never> {
      throw new Error(NO_PROVIDER_MESSAGE);
    },
  };
}
