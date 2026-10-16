/**
 * Expo Router hands its incoming-link handler its own fork of the state parser
 * (`expo-router/build/fork/getStateFromPath`, wired in `build/getLinkingConfig.js`). That fork
 * reads the query with `URLSearchParams`, so the patched `decode-uri-component` is not on the
 * deep-link path (review M018). If an Expo Router upgrade sends link queries through
 * `query-string` again, this test fails and docs/REVIEW_REMEDIATION_2026-10-03.md needs another
 * look. This is the component project because the fork imports React Native source.
 */
type ParsedState = { routes: { name: string; params?: Record<string, unknown> }[] } | undefined;
type GetStateFromPath = (path: string, options: { screens: Record<string, string> }) => ParsedState;

const PATH = '/chat/test?body=hello+world&literal=%2B&bad=%C3%41';
const CONFIG = { screens: { Chat: 'chat/:guid' } };

function parseWithCountingDecoder(modulePath: string): {
  state: ParsedState;
  decoded: string[];
} {
  const decoded: string[] = [];
  const result: { state?: ParsedState } = {};
  jest.isolateModules(() => {
    jest.doMock('decode-uri-component', () => {
      const real = jest.requireActual<(value: string) => string>('decode-uri-component');
      return (value: string) => {
        decoded.push(value);
        return real(value);
      };
    });
    const { getStateFromPath } = require(modulePath) as { getStateFromPath: GetStateFromPath };
    result.state = getStateFromPath(PATH, CONFIG);
  });
  return { state: result.state, decoded };
}

describe('Expo Router incoming-link query parsing (M018)', () => {
  it('reads link queries without the patched URI decoder', () => {
    const { state, decoded } = parseWithCountingDecoder('expo-router/build/fork/getStateFromPath');

    expect(decoded).toEqual([]);
    // A malformed escape follows URLSearchParams rules (a replacement character), not the
    // patched decoder's '%C3A'.
    expect(state?.routes[0]).toMatchObject({
      name: 'Chat',
      params: { guid: 'test', body: 'hello world', literal: '+', bad: '�A' },
    });
  });

  it('counts decoder calls when a parser does use it: the vendored core parser', () => {
    const { state, decoded } = parseWithCountingDecoder(
      'expo-router/build/react-navigation/core/getStateFromPath',
    );

    expect(decoded.length).toBeGreaterThan(0);
    expect(state?.routes[0]?.params).toMatchObject({ bad: '%C3A' });
  });
});
