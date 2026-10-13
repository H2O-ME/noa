/**
 * The kernel handle layer (M11): `AgentSession` drives runs, logs and events;
 * `KernelEvent` is the ONE protocol every surface consumes. The surface-plugin
 * contract (`AgentSurface` and friends) lives in `surface.ts` — its own
 * responsibility, kept out of this barrel so neither file balloons. The
 * assembly of a concrete session (provider + plugin host + permission engine)
 * lives in the plugins package (`createAgentKernel`) — core stays provider- and
 * host-agnostic, the same way `runAgent` takes a `ChatProvider` interface.
 *
 * "Model-visible means logged" is enforced inside `AgentSession`: surfaces never
 * persist, never bookkeep, never guess phases.
 */
export * from './surface.js';
export * from './kernel/protocol.js';
export * from './kernel/model.js';
export * from './kernel/model-control.js';
export { EventPump } from './kernel/pump.js';
export { RunMeter, type RunStats, type RequestTiming } from './kernel/metrics.js';
export {
  AgentSession,
  type AgentSessionDeps,
  type UsageAnchorState,
} from './kernel/session.js';
