/**
 * FaceTime join-link validation.
 *
 * A FaceTime link is supplied by the BlueBubbles/Gator server (the answer + link-mint
 * ops) and carried in Notifee action data — both attacker-influenceable. Before we ever
 * `Linking.openURL` it OR load it in the in-app call WebView, we confirm it's a real
 * FaceTime link, never an arbitrary scheme/Intent (a compromised server could otherwise
 * return `intent://` / `tel:` / a deep link). See AGENTS.md ("A server-supplied URL
 * opened via Linking.openURL MUST be scheme-validated").
 *
 * React-free so it runs in Node tests + the headless notification handler.
 */
const FACETIME_LINK_RE = /^(facetime:|https:\/\/facetime\.apple\.com\/)/i;

/** True only for an Apple FaceTime link (`facetime:` or `https://facetime.apple.com/…`). */
export function isFaceTimeLink(url: string | null | undefined): url is string {
  return typeof url === 'string' && FACETIME_LINK_RE.test(url);
}
