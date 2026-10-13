/**
 * Who may drive this machine over QQ.
 *
 * A chat channel is a public input surface: anybody who can reach the robot can
 * type at it, and a group message reaches every member. The loaded row has the
 * same authority the host has, so without this gate every one of those people
 * could raise the permission tier, answer an approval meant for somebody else, or
 * simply ask the model to run things.
 *
 * The properties pinned here are the ones the deployment targets demand. Both are
 * LONG-LIVED relationships — a phone driving a desktop, and a headless server —
 * so authorization is a durable binding plus a STANDING enrollment secret, never a
 * one-time ceremony: a secret consumed by use would strand the operator's second
 * device, and on a GUI-less server there is no settings page to mint another.
 */
import { describe, expect, it } from 'vitest';
import { AccessGate, clampTier, isOwner, mintPairingCode, type AccessPolicy } from '../src/access.js';

const policy = (
  owners: readonly string[],
  overrides: Partial<AccessPolicy> = {},
): AccessPolicy => ({ owners: [...owners], maxTier: 'read-only', ...overrides });

const gate = new AccessGate();

describe('who counts as an owner', () => {
  it('requires the ACTOR, never the conversation', () => {
    // A group id is shared by every member, so authorizing on it would authorize
    // the whole group — including people who merely happen to be in it.
    const p = policy(['MEMBER-A']);
    expect(isOwner(p, 'MEMBER-A')).toBe(true);
    expect(isOwner(p, 'MEMBER-B')).toBe(false);
    expect(isOwner(p, 'group:G1')).toBe(false);
  });

  it('never authorizes an unknown sender', () => {
    // "We could not tell who this is" must not read as "anybody".
    expect(isOwner(policy(['A']), '')).toBe(false);
    expect(isOwner(policy([]), 'A')).toBe(false);
  });
});

describe('the tier ceiling', () => {
  it('clamps downward only', () => {
    expect(clampTier('full', 'read-only')).toBe('read-only');
    expect(clampTier('auto-edit', 'full')).toBe('auto-edit');
    expect(clampTier('read-only', 'auto-edit')).toBe('read-only');
  });
});

describe('enrollment is a standing arrangement', () => {
  const unbound = policy([], { pairingCode: 'ABCDEFGHJK' });

  it('refuses everything until somebody enrolls, and says what to do', () => {
    for (const text of ['帮我删掉这个文件', '/perm full', '/status']) {
      const verdict = gate.check(unbound, 'STRANGER', 'c2c', text);
      expect(verdict.kind).toBe('refuse');
      expect(verdict.kind === 'refuse' ? verdict.reply : '').toContain('/pair');
    }
  });

  it('enrolls only in a PRIVATE chat', () => {
    // The secret is a standing credential: a group reply would publish it to
    // everyone there, including whoever asked for it.
    expect(gate.check(unbound, 'STRANGER', 'group', '/pair ABCDEFGHJK').kind).toBe('refuse');
    expect(gate.check(unbound, 'STRANGER', 'c2c', '/pair ABCDEFGHJK')).toEqual({
      kind: 'paired',
      actorId: 'STRANGER',
      reply: expect.stringContaining('配对成功'),
    });
  });

  it('does NOT consume the secret, so a second device enrolls later', () => {
    // This is the correction that matters: a used-up secret would make enrolling a
    // second device (or re-enrolling after a reset) impossible without walking back
    // to a settings page a headless server does not have.
    expect(gate.check(unbound, 'PHONE', 'c2c', '/pair ABCDEFGHJK').kind).toBe('paired');
    expect(gate.check(unbound, 'LAPTOP', 'c2c', '/pair ABCDEFGHJK').kind).toBe('paired');
    // Case-insensitive: a secret read off a screen gets retyped.
    expect(gate.check(unbound, 'TABLET', 'c2c', '/pair abcdefghjk').kind).toBe('paired');
  });

  it('closes enrollment when the secret is cleared, and refuses a wrong one', () => {
    expect(gate.check(policy([]), 'STRANGER', 'c2c', '/pair ABCDEFGHJK').kind).toBe('refuse');
    expect(gate.check(unbound, 'STRANGER', 'c2c', '/pair WRONGWRONG').kind).toBe('refuse');
    // A wrong attempt does not burn the secret (there is no attempt counter, and
    // one would be a lockout an attacker could trigger).
    expect(gate.check(unbound, 'STRANGER', 'c2c', '/pair ABCDEFGHJK').kind).toBe('paired');
  });

  it('lets a bound owner straight through', () => {
    const bound = policy(['OWNER'], { pairingCode: 'ABCDEFGHJK' });
    for (const text of ['随便问点什么', '/perm read-only', '/compact', '/use ab12']) {
      expect(gate.check(bound, 'OWNER', 'group', text)).toEqual({ kind: 'allow' });
    }
  });

  it('mints a secret that is a credential, with no look-alikes', () => {
    const code = mintPairingCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/u);
    expect(mintPairingCode()).not.toBe(code);
  });
});
