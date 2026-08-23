import { timingSafeEqual, toBase64, utf8Encode } from '@utils/bytes';
import type { CryptoBackend } from '../crypto';
import type { SecureVault } from './vault';

/**
 * Hardened gate for external automation (Tasker-style) intents.
 *
 * The Flutter app exposed an `exported=true` BroadcastReceiver guarded only by a
 * plaintext `password == storedPassword` compare — i.e. the SERVER PASSWORD was the gate,
 * stored in cleartext and compared non-constant-time. This replaces that with:
 *   - a ROTATING per-install token (not the server password), minted from the CSPRNG and
 *     stored in the Keystore-backed vault,
 *   - a CONSTANT-TIME token compare,
 *   - a default-deny ACTION allowlist,
 *   - per-action param sanitization (so a reflected value can't inject into the reply).
 *
 * This is the JS validation core. The actual exported native receiver that feeds intents
 * here is a separate native-rebuild item; until it lands this core is inert (no caller)
 * but fully unit-tested.
 */

/** Automation actions the app will service. Anything else is rejected (default-deny). */
export const ALLOWED_ACTIONS = ['com.gator.external.GET_SERVER_URL'] as const;
export type AutomationAction = (typeof ALLOWED_ACTIONS)[number];

function isAllowedAction(action: string): action is AutomationAction {
  return (ALLOWED_ACTIONS as readonly string[]).includes(action);
}

const TOKEN_BYTES = 32;

/**
 * Read the per-install automation token, minting + persisting a fresh 256-bit random one
 * on first use. The native composition root injects the CSPRNG so this core module stays
 * platform-free. This — NOT the server password — is what an external automation must
 * present. Idempotent: returns the same token until it is rotated.
 */
export async function getOrCreateAutomationToken(
  vault: SecureVault,
  crypto: Pick<CryptoBackend, 'randomBytes'>,
): Promise<string> {
  const existing = await vault.get('automationToken');
  if (existing) return existing;
  return mintToken(vault, crypto);
}

/** Replace the automation token with a fresh one — revokes every existing automation. */
export async function rotateAutomationToken(
  vault: SecureVault,
  crypto: Pick<CryptoBackend, 'randomBytes'>,
): Promise<string> {
  return mintToken(vault, crypto);
}

async function mintToken(
  vault: SecureVault,
  crypto: Pick<CryptoBackend, 'randomBytes'>,
): Promise<string> {
  const bytes = await crypto.randomBytes(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) {
    throw new Error(
      `Secure random backend returned ${bytes.length} bytes; expected ${TOKEN_BYTES}.`,
    );
  }
  const token = toBase64(bytes);
  await vault.set('automationToken', token);
  return token;
}

export type IntentResult =
  | { ok: true; action: AutomationAction; params: Record<string, string> }
  | { ok: false; reason: 'unknown_action' | 'bad_token' | 'malformed' };

/**
 * Gate an incoming automation intent. The action must be whitelisted AND the presented
 * token must constant-time-match the stored per-install token; a never-minted token
 * always fails. On success returns the SANITIZED params for that action.
 */
export async function validateIntent(
  input: { action: string; token: string; params?: Record<string, unknown> },
  vault: SecureVault,
): Promise<IntentResult> {
  const { action, token } = input;
  if (typeof action !== 'string' || action.length === 0 || action.length > 256) {
    return { ok: false, reason: 'malformed' };
  }
  if (!isAllowedAction(action)) return { ok: false, reason: 'unknown_action' };

  const stored = await vault.get('automationToken');
  // No stored token (fresh install) or no presented token => always fail.
  if (!stored || typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'bad_token' };
  }
  if (!timingSafeEqual(utf8Encode(token), utf8Encode(stored))) {
    return { ok: false, reason: 'bad_token' };
  }
  return { ok: true, action, params: sanitizeIntentParams(action, input.params ?? {}) };
}

/**
 * Per-action allowlist of params, hardened: only known keys survive, values are
 * control-char-stripped, length-capped, and scheme/URL-shaped values are refused (so a
 * reflected caller value can't inject into the outbound broadcast).
 */
export function sanitizeIntentParams(
  action: AutomationAction,
  raw: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (action === 'com.gator.external.GET_SERVER_URL') {
    // Only an opaque caller `id` is echoed back to the automation.
    const id = sanitizeOpaque(raw['id']);
    if (id) out['id'] = id;
  }
  return out;
}

function sanitizeOpaque(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim(); // strip control chars / CRLF
  if (!v || v.length > 128) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // refuse scheme/URL-shaped values
  return v;
}
