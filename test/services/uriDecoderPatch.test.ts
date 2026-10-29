import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Exercise installed CommonJS consumers, including the vendored React Navigation core parser, which
// still calls query-string. Expo Router's own link parser does not use this decoder (review M018):
// see test/components/routes/routerLinkQueryParser.test.tsx. A version-only override to the
// upstream ESM package would break this contract before any screen can mount.
const installed = createRequire(join(process.cwd(), 'package.json'));
const decodePath = installed.resolve('decode-uri-component');
const decode = installed(decodePath) as (input: unknown) => string;
const queryString = installed('query-string') as { parse(input: string): Record<string, unknown> };
const routerPath = join(
  dirname(installed.resolve('expo-router/package.json')),
  'build/react-navigation/core/getStateFromPath.js',
);
const { getStateFromPath } = installed(routerPath) as {
  getStateFromPath(path: string, config: unknown): { routes: { name: string; params: unknown }[] };
};

describe('compatible URI decoder security patch', () => {
  it.each([
    ['hello+world', 'hello world'],
    ['%2B+%25', '+ %'],
    ['%E4%BD%A0%E5%A5%BD%F0%9F%98%80', '你好😀'],
    ['%C3%41', '%C3A'],
    ['%E2%82', '%E2%82'],
    ['%C0%AF', '%C0%AF'],
    ['%ED%A0%80', '%ED%A0%80'],
    ['%F4%90%80%80', '%F4%90%80%80'],
    ['%FE%FF', '\uFFFD\uFFFD'],
    ['%C2', '\uFFFD'],
    ['tail%G%', 'tail%G%'],
    ['%84%D7%25%88%90', '%84%D7%%88%90'],
    ['%20%20%25%80', '  %%80'],
    // GHSA-qr28-fpjm-wq7f (upstream 0.5.1): runs decode in one pass and are never decoded again.
    ['%41%FE%FF', 'A\uFFFD\uFFFD'],
    ['%25C2%zz', '%C2%zz'],
    ['%25%41%zz', '%A%zz'],
  ])('decodes %s without recombining malformed percent separators', (input, expected) => {
    expect(decode(input)).toBe(expected);
  });

  it('retains the callable CommonJS API and query-string form semantics', () => {
    expect(typeof decode).toBe('function');
    expect(() => decode(null)).toThrow(TypeError);
    expect({ ...queryString.parse('body=hello+world&literal=%2B&bad=%C3%41&dup=a&dup=b') }).toEqual(
      {
        body: 'hello world',
        literal: '+',
        bad: '%C3A',
        dup: ['a', 'b'],
      },
    );
  });

  it('parses through the vendored React Navigation core parser, which still calls query-string', () => {
    const state = getStateFromPath('/chat/test?body=hello+world&literal=%2B&bad=%C3%41', {
      screens: { Chat: 'chat/:guid' },
    });
    expect(state.routes[0]).toMatchObject({
      name: 'Chat',
      params: {
        guid: 'test',
        body: 'hello world',
        literal: '+',
        bad: '%C3A',
      },
    });
  });

  it('finishes large malformed input under a bounded child-process deadline', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=128',
        '-e',
        `
      const assert = require('node:assert/strict');
      const decode = require(process.argv[1]);
      for (const count of [1000, 10000]) {
        assert.equal(decode('%FF'.repeat(count)), '%FF'.repeat(count));
        assert.equal(decode('%C3%41'.repeat(count)), '%C3A'.repeat(count));
        assert.equal(decode('%F0%9F%98%80%FF'.repeat(count)), '😀%FF'.repeat(count));
      }
      // Many DISTINCT percent-encoded runs plus a malformed tail: the pre-0.5.1 replace loop was
      // quadratic here (about 28 s on a dev Mac); single-pass decoding takes tens of milliseconds.
      let distinctRuns = '';
      for (let index = 0; index < 32000; index++) {
        const high = Math.floor(index / 256).toString(16).padStart(2, '0');
        const low = (index % 256).toString(16).padStart(2, '0');
        distinctRuns += '%' + high + '%' + low + 'x';
      }
      decode(distinctRuns + '%zz');
      process.stdout.write('bounded malformed decoding passed');
    `,
        decodePath,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('bounded malformed decoding passed');
  });
});
