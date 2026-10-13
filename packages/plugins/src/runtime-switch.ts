/**
 * The settings panel's switches: flipping one plugin ROW or one skill.
 *
 * Split from `runtime-roster.ts` (what LOADS) because this is what the panel
 * CHANGES, and the readers differ — the router calls these, the boot path never
 * does. One module, one discipline: **persist first, then reload, then verify**.
 * A successful call means the durable plugin tree and the live kernel agree. A
 * throw from the WRITE means neither moved. A throw from the VERIFY means both
 * DID move — the operator's intent is durable (the row stays written with its
 * load failure, which the panel reports) and only the flip is reported as
 * failed; re-enabling a row whose module cannot load is the case that lands
 * here.
 *
 * There is no per-tier list routing any more. A row is switched by writing ITS
 * entry (`{ id, enabled }`), which is the same field the boot path reads — so a
 * flip cannot disagree with a restart, and there is no second door that could
 * put a switched-off plugin back.
 */
import { isRequiredTier, pluginConfig as pluginConfigKey, skills as skillsKey } from '@noa/core';
import type { Environment } from './runtime-env.js';

/**
 * Flip one plugin row.
 *
 * The row must exist in the resolved tree: an id nothing provides is refused
 * here rather than written as an entry that can never be read back. A `core`
 * row refuses outright — it is load-bearing, and the panel draws no switch for
 * it in the first place.
 *
 * The write goes through the `plugin-config` SERVICE, the same door a plugin
 * uses to save its own settings: one writer for the durable tree, so a switch
 * flipped by the panel and one written by a plugin's own page cannot disagree.
 *
 * @param env - the live environment.
 * @param id - the entry id (a built-in name or a module specifier).
 * @param enabled - whether the row should load.
 * @returns the ids now switched off, as the panel lists them.
 */
export async function setPluginEnabled(
  env: Environment,
  id: string,
  enabled: boolean,
): Promise<readonly string[]> {
  const row = env.state.rows.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(`unknown plugin "${id}" (no row with that id in the resolved tree)`);
  }
  if (isRequiredTier(row.manifest.tier)) {
    throw new Error(`plugin "${id}" is load-bearing and cannot be turned off`);
  }
  // The write re-rosters through the `plugin-config` service (see
  // `plugin-services.ts`), which re-READS the document first, so the tree that
  // follows the write is built from the tree the operator just wrote.
  await env.root.must(pluginConfigKey).setEntry(id, { enabled });
  // Verified against the ROW, by the id the config uses — not against the
  // container's roster, which knows a fiber by the plugin's own `name` and so
  // cannot find a spec-loaded row at all.
  const live = env.state.host?.entry(id);
  // A row that could not even be IMPORTED never reached the loader: its reason
  // sits on the tree row (filtered out of the sync), not on the loader's entry,
  // which still holds the pre-flip disabled row with no error on it.
  const failure = live?.error ?? env.state.rows.find((candidate) => candidate.id === id)?.error;
  const loaded = live?.fiber !== undefined;
  if (enabled && !loaded) {
    throw new Error(`plugin "${id}" did not load after enabling${failure !== undefined ? `: ${failure}` : ''}`);
  }
  if (!enabled && loaded) {
    throw new Error(`plugin "${id}" is still loaded after disabling`);
  }
  return env.state.rows.filter((candidate) => !candidate.enabled).map((candidate) => candidate.id);
}

/**
 * Flip one skill's switch. Persists `skills.disable`, then reloads the skill
 * index the same way a workspace switch does — the `<available_skills>` block
 * and the `skill` tool both read that list, so one reload governs both doors.
 * A reloaded index also refreshes the `skills` provider, whose `all()` reads
 * the same state.
 *
 * @param env - the live environment.
 * @param name - the skill's name, both levels.
 * @param enabled - whether it should be injected and callable.
 * @returns the disable list now in force.
 */
export async function setSkillEnabled(
  env: Environment,
  name: string,
  enabled: boolean,
): Promise<readonly string[]> {
  const persist = env.state.persistSkills;
  if (persist === undefined) {
    throw new Error('this invocation has no writable config file (headless run or embedded kernel)');
  }
  // Checked against the UNFILTERED discovery (`loadWorkspace` applies the
  // current disable list, so call it with the name temporarily allowed): the
  // skill being flipped must be discoverable right now, or the name is a typo.
  // A typo would otherwise write a disable entry that can never be read back as
  // a row — the same fail-loud discipline the plugin rows apply, enforced here
  // instead of warned because the panel is interactive and can say so.
  const previous = env.state.skillsDisable;
  env.state.skillsDisable = previous.filter((entry) => entry !== name);
  let names: Set<string>;
  try {
    names = new Set((await env.loadWorkspace()).map((skill) => skill.name));
  } finally {
    env.state.skillsDisable = previous;
    await env.loadWorkspace();
  }
  if (!names.has(name)) {
    throw new Error(`unknown skill "${name}" (no SKILL.md with that name in project or user roots)`);
  }
  const disable = await persist(name, enabled);
  env.state.skillsDisable = [...disable];
  // The provider's `reload` re-runs loadWorkspace itself (it IS the same scan);
  // calling both would run the full skill discovery twice for one flip.
  await env.root.must(skillsKey).reload();
  return disable;
}
