/**
 * A plugin's settings page, as DATA.
 *
 * The host renders one of these generically and knows nothing about any plugin,
 * which is the point: a channel that needs two credentials and a probe button
 * ships its own page by RETURNING one of these from its RPC namespace, instead
 * of the host growing a hand-written section (and a frame family, and a
 * nav entry) per plugin. The vocabulary lives in core next to the protocol it
 * belongs to, so both sides — the owning plugin and the browser-facing host —
 * type against one definition rather than a mirrored pair.
 *
 * Values here are for DISPLAY. A secret's value is never part of a descriptor:
 * a field may say a secret is set and may name an `{env:NAME}` reference, which
 * is inert text the operator wrote, but the secret itself never leaves the
 * process that holds it.
 */

/** One field a plugin's own settings page renders. */
export interface PluginSettingField {
  key: string;
  label: string;
  kind: 'text' | 'secret' | 'select' | 'switch';
  value?: string;
  placeholder?: string;
  hint?: string;
  options?: readonly { value: string; label: string }[];
}

/** One row of read-only status a plugin's page shows. */
export interface PluginSettingStatus {
  label: string;
  value: string;
  tone?: 'ok' | 'warn' | 'bad';
}

/** One action button a plugin's page offers. */
export interface PluginSettingAction {
  id: string;
  label: string;
  kind?: 'primary' | 'plain';
  /**
   * The action takes something away and cannot be undone (unbinding every
   * device, dropping a stored credential). The renderer asks a SECOND click
   * before it sends: the first press arms the row, the second commits. The
   * plugin still owns the decision — this only costs one mis-aimed click.
   */
  danger?: boolean;
}

/** One copyable value a page wants the operator to take away (a pairing code). */
export interface PluginSettingCopyValue {
  label: string;
  value: string;
  hint?: string;
}

/**
 * A plugin's OWN settings page, as data.
 *
 * The host renders this generically: it knows nothing about any plugin, so a
 * new plugin ships a page by returning one of these instead of the host growing
 * a hand-written section per channel.
 */
export interface PluginPageDescriptor {
  title: string;
  intro?: string;
  guide?: readonly string[];
  status?: readonly PluginSettingStatus[];
  note?: string;
  /** A value worth copying verbatim, shown as its own block — not prose. */
  copy?: PluginSettingCopyValue;
  fields?: readonly PluginSettingField[];
  actions?: readonly PluginSettingAction[];
}
