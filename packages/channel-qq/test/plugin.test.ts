/**
 * 插件那一半的契约：**没有可用凭据就什么都不启动**。
 *
 * 这个文件钉的正是本次重构要修的那件事——「宿主留着一份候选对象就拨号」。在这里，
 * 行自己的 config 里没有可用凭据时，插件必须既不建通道（`runningQqBotChannel()`
 * 为 undefined）、也不碰 session 服务（假实现会在被调用时抛）。
 *
 * 第二条钉的是「失败是**日志**，不是行激活失败」：给一份字面密钥时通道会去拨号
 * （fetch 被替换成立刻失败的假实现，测试不联网），而拨号失败只落成一条 `warn`——
 * 行本身照常激活。行激活失败会连它自持的通道一起弄丢，那正是要避免的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Context,
  sessions as sessionsKey,
  tools as toolsKey,
  type Logger,
  type SessionService,
  type ToolDefinition,
  type ToolRegistry,
} from '@noa/core';
import plugin, { runningQqBotChannel } from '../src/plugin.js';

/** 会话服务：被调用即说明「没有凭据也开了会话」，那是 bug。 */
function fakeSessions(): SessionService {
  return {
    current: () => undefined,
    open: () => Promise.reject(new Error('the channel must not open a session without credentials')),
    activate: () => undefined,
  };
}

/** 最小工具注册表：只回答「注册了什么」，供这一行装配使用。 */
function fakeTools(): ToolRegistry {
  const entries = new Map<string, ToolDefinition>();
  return {
    all: () => [...entries.values()],
    entries: () => [...entries.values()].map((tool) => ({ tool, permission: 'read' as const, owner: 'qqbot' })),
    find: (name) => entries.get(name),
    permissionFor: async (name) => (entries.has(name) ? 'read' : undefined),
    register: (tool) => {
      entries.set(tool.name, tool);
      return () => entries.delete(tool.name);
    },
  };
}

interface Mounted {
  readonly lines: string[];
  dispose(): Promise<void>;
}

/** 装配一次这一行的激活；`config` 是行自己的设置（由 `Config` 校验）。 */
async function mount(config: unknown): Promise<Mounted> {
  const lines: string[] = [];
  const log: Logger = (level, message) => {
    lines.push(`${level}: ${message}`);
  };
  const root: Context = Context.createRoot({ log });
  // The tool registry IS needed: this row registers `qq_send_file` (the only way
  // a file the agent produced reaches the peer).
  root.provide(toolsKey, fakeTools());
  root.provide(sessionsKey, fakeSessions());
  const fiber = root.plugin(plugin, config);
  await fiber.ready;
  mounted = { lines, dispose: () => fiber.dispose() };
  return mounted;
}

let mounted: Mounted | undefined;

afterEach(async () => {
  // The channel is process-wide state; leaving it registered would leak into the
  // next test (and that is exactly what the plugin's own effect must undo).
  await mounted?.dispose();
  mounted = undefined;
  expect(runningQqBotChannel()).toBeUndefined();
});

describe('qqbot plugin without credentials', () => {
  it('starts nothing at all', async () => {
    await mount({});
    expect(runningQqBotChannel()).toBeUndefined();
  });

  it('treats an unresolved {env:NAME} reference as "no credentials yet"', async () => {
    await mount({ appId: '1024', clientSecret: '{env:QQ_SECRET_NOT_SET_ANYWHERE}' });
    expect(runningQqBotChannel()).toBeUndefined();
  });
});

describe('qqbot plugin with credentials', () => {
  it('dials, and turns a failed dial into a warn line rather than a failed row', async () => {
    // The dial is a real code path; only the transport is faked, so a 401 lands
    // where a bad secret lands in production — as a reason, not as a crash.
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) }),
    );
    try {
      const active = await mount({ appId: '1024', clientSecret: 'literal-secret-xyz' });
      expect(runningQqBotChannel()).toBeDefined();
      // Let the async dial settle.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const failure = active.lines.find(
        (line) => line.startsWith('warn:') && line.includes('access token request failed'),
      );
      expect(failure, 'a failed dial must be logged, not thrown').toBeDefined();
      expect(failure).not.toContain('literal-secret-xyz');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
