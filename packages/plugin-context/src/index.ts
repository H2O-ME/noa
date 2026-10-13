/**
 * The `context` plugin: it provides the context-insight capability and nothing
 * else.
 *
 * A plugin with no tools, no commands and no hooks is unusual here, so the
 * reason belongs in writing: reading a session's window is a WALK OVER THE WHOLE
 * LOG, and most sessions never ask for it. Making it a tier-gated provider is
 * what keeps that cost off the default install — the fold runs only when
 * something consumes the service, and the consumer is the web surface, which
 * renders the panel only when the service is there. So the presence of this
 * provider IS the on/off switch: there is no second flag, and no way for a
 * settings row and the data to disagree about whether the feature is on.
 *
 * It is `advanced` (off until a `plugins.entries` row enables it), declared in the
 * manifest below rather than described here — the same reason `subagent` and `ptc`
 * are: nothing a fresh install needs, and its absence costs a reader only a tab
 * that is not drawn.
 */
import { contextInsights as contextInsightsKey, type Plugin } from '@noa/core';
import { contextInsightsOf, windowAtSeq } from './fold.js';

// Re-exported so the web surface can fold a session log into one request's
// window snapshot — the Browser/DNA cards' read. The ONE definition of "what
// was in the window" lives in `fold.ts`; re-exporting it keeps the trend's view
// of a past request and the cards' view from disagreeing.
export { windowAtSeq };

export const contextPlugin: Plugin = {
  name: 'context',
  description: 'Folds a session log into a context reading: composition, per-request trend, events and file activity.',
  // The tier lives HERE, in the plugin's own manifest. With no manifest at all,
  // `manifestOf` fail-opens the row to `standard` — so this provider used to
  // ship ON while its own docstring said it ships off.
  manifest: {
    title: '上下文洞察',
    description: '把一个会话日志折叠成一次上下文读数：构成、逐请求趋势、事件与文件活动。',
    tier: 'advanced',
  },
  apply(ctx): void {
    ctx.provide(contextInsightsKey, contextInsightsOf());
  },
};

// The shape a spec-loaded module must present: the plugin tree unwraps `default`
// (or `plugin`) and validates it, so a package that exports only a NAMED object
// is a package the tree cannot load.
export default contextPlugin;
