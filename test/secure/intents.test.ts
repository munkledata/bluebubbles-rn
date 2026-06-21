import {
  ALLOWED_ACTIONS,
  getOrCreateAutomationToken,
  InMemoryVault,
  rotateAutomationToken,
  sanitizeIntentParams,
  validateIntent,
} from '@core/secure';

// mintToken lazy-imports expo-crypto; mock it with a per-call-varying CSPRNG stub.
jest.mock('expo-crypto', () => {
  let n = 0;
  return { getRandomBytes: (len: number) => new Uint8Array(len).fill((n++ % 254) + 1) };
});

const ACTION = ALLOWED_ACTIONS[0]; // 'com.bluebubbles.external.GET_SERVER_URL'

describe('automation token', () => {
  it('mints + persists on first use and is idempotent', async () => {
    const vault = new InMemoryVault();
    const a = await getOrCreateAutomationToken(vault);
    expect(a).toBeTruthy();
    expect(await vault.get('automationToken')).toBe(a);
    expect(await getOrCreateAutomationToken(vault)).toBe(a); // same token, no re-mint
  });

  it('rotate produces a different token and the old one stops validating', async () => {
    const vault = new InMemoryVault();
    const old = await getOrCreateAutomationToken(vault);
    const next = await rotateAutomationToken(vault);
    expect(next).not.toBe(old);
    expect((await validateIntent({ action: ACTION, token: old }, vault)).ok).toBe(false);
    expect((await validateIntent({ action: ACTION, token: next }, vault)).ok).toBe(true);
  });
});

describe('validateIntent', () => {
  it('rejects a non-whitelisted action even with the correct token (default-deny)', async () => {
    const vault = new InMemoryVault();
    const token = await getOrCreateAutomationToken(vault);
    const r = await validateIntent({ action: 'com.evil.DO_THING', token }, vault);
    expect(r).toEqual({ ok: false, reason: 'unknown_action' });
  });

  it('rejects a malformed (empty / oversized) action', async () => {
    const vault = new InMemoryVault();
    await getOrCreateAutomationToken(vault);
    expect((await validateIntent({ action: '', token: 'x' }, vault)).ok).toBe(false);
    expect((await validateIntent({ action: 'a'.repeat(300), token: 'x' }, vault)).ok).toBe(false);
  });

  it('rejects a wrong, empty, or missing token; accepts the exact token', async () => {
    const vault = new InMemoryVault();
    const token = await getOrCreateAutomationToken(vault);
    expect(await validateIntent({ action: ACTION, token: 'wrong' }, vault)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect(await validateIntent({ action: ACTION, token: '' }, vault)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect((await validateIntent({ action: ACTION, token }, vault)).ok).toBe(true);
  });

  it('always fails when no token was ever minted (fresh install)', async () => {
    const vault = new InMemoryVault();
    expect(await validateIntent({ action: ACTION, token: 'anything' }, vault)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
    expect(await validateIntent({ action: ACTION, token: '' }, vault)).toEqual({
      ok: false,
      reason: 'bad_token',
    });
  });

  it('happy path returns the action + sanitized params', async () => {
    const vault = new InMemoryVault();
    const token = await getOrCreateAutomationToken(vault);
    const r = await validateIntent(
      { action: ACTION, token, params: { id: 'caller-1', junk: 'drop-me' } },
      vault,
    );
    expect(r).toEqual({ ok: true, action: ACTION, params: { id: 'caller-1' } });
  });
});

describe('sanitizeIntentParams (GET_SERVER_URL)', () => {
  it('keeps only the opaque id, dropping unknown keys', () => {
    expect(sanitizeIntentParams(ACTION, { id: 'abc123', other: 'x' })).toEqual({ id: 'abc123' });
  });

  it('strips control chars / CRLF from the id', () => {
    expect(sanitizeIntentParams(ACTION, { id: 'a\r\nb\tc' })).toEqual({ id: 'abc' });
  });

  it('drops an over-length id', () => {
    expect(sanitizeIntentParams(ACTION, { id: 'x'.repeat(200) })).toEqual({});
  });

  it('refuses scheme/URL-shaped ids (no injection into the reply broadcast)', () => {
    expect(sanitizeIntentParams(ACTION, { id: 'intent://scan' })).toEqual({});
    expect(sanitizeIntentParams(ACTION, { id: 'javascript:alert(1)' })).toEqual({});
  });

  it('ignores non-string id', () => {
    expect(sanitizeIntentParams(ACTION, { id: 123 })).toEqual({});
  });
});
