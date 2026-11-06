/**
 * Review M018 concerned the vulnerable `decode-uri-component`, which `query-string` pulled onto
 * Expo Router's incoming-link path and which the repository patched locally. Since Expo SDK 58
 * neither package is installed at all: the linking parser (`expo-router/build/link/linking`, wired
 * in `build/getLinkingConfig.js`) reads the query with `URLSearchParams`. This test pins both facts
 * so an Expo upgrade that brings `query-string` back fails here and
 * docs/REVIEW_REMEDIATION_2026-10-03.md gets another look. Component project: the parser imports
 * React Native source.
 */
type ParsedState = { routes: { name: string; params?: Record<string, unknown> }[] } | undefined;
type GetStateFromPath = (path: string, options: { screens: Record<string, string> }) => ParsedState;

const PATH = '/chat/test?body=hello+world&literal=%2B&bad=%C3%41';
const CONFIG = { screens: { Chat: 'chat/:guid' } };

describe('Expo Router incoming-link query parsing (M018)', () => {
  it('ships neither decode-uri-component nor query-string', () => {
    for (const name of ['decode-uri-component', 'query-string']) {
      expect(() => require.resolve(name)).toThrow(/Cannot find module/);
    }
  });

  it('reads link queries with URLSearchParams semantics', () => {
    const { getStateFromPath } = require('expo-router/build/link/linking') as {
      getStateFromPath: GetStateFromPath;
    };
    const state = getStateFromPath(PATH, CONFIG);
    expect(state?.routes[0]).toMatchObject({
      name: 'Chat',
      params: { guid: 'test', body: 'hello world', literal: '+' },
    });
    // A malformed escape becomes replacement characters (URLSearchParams/TextDecoder rules; the
    // exact count differs between parser versions), never the old patched decoder's '%C3A' and
    // never a thrown error.
    const bad = state?.routes[0]?.params?.bad;
    expect(typeof bad).toBe('string');
    expect(bad).toContain('\uFFFD');
    expect(bad).not.toContain('%');
  });
});
