/**
 * The qqbot connection probe: token grant, then gateway lookup.
 *
 * The row's own `test` action calls this, and it is the only piece of the
 * package that reaches QQ purely to ASK a question — the gateway state machine
 * and the REST client are the channel's own traffic. Keeping it apart makes
 * "what this package sends on behalf of a settings page" a file you can read in
 * full.
 */
import { AccessTokenManager } from './protocol.js';

/**
 * Prove the credentials work end to end and return the gateway URL.
 *
 * "Configured" and "working" are different facts, and only a real round trip can
 * tell them apart: the token grant validates the secret, the gateway lookup
 * validates the app id's standing. The settings page shows the URL as the
 * evidence, so this returns it rather than a bare boolean.
 * @param opts - the candidate credentials (the operator's typed secret, not the stored one).
 * @returns the gateway URL the credentials resolved to.
 * @throws when the grant fails or the gateway answer is unusable.
 */
export async function probeQqBotConnection(opts: { appId: string; clientSecret: string }): Promise<string> {
  const manager = new AccessTokenManager(opts.appId, opts.clientSecret, globalThis.fetch);
  const token = await manager.get();
  if (token.length === 0) throw new Error('empty access token');
  const res = await globalThis.fetch('https://api.sgroup.qq.com/gateway/bot', {
    headers: { Authorization: `QQBot ${token}` },
  });
  const body = (await res.json().catch(() => undefined)) as { url?: unknown } | undefined;
  if (!res.ok || typeof body?.url !== 'string') {
    throw new Error(`gateway lookup failed (http ${res.status})`);
  }
  return body.url;
}
