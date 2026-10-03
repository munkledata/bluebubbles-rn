import { createRequire } from 'node:module';
import { join } from 'node:path';

const installed = createRequire(join(process.cwd(), 'package.json'));
const braces = installed('braces');
const micromatch = installed('micromatch');
const depthError = /exceeds max depth/;

function nest(count: number, kind = 'brace'): string {
  let input = 'a,b';
  for (let index = 0; index < count; index += 1) {
    const paren = kind === 'paren' || (kind === 'mixed' && index % 2 === 0);
    input = paren ? `(${input})` : `{${input}}`;
  }
  return input;
}

describe.each(['brace', 'paren', 'mixed'])('bounded %s pattern nesting', (kind) => {
  it.each(['parse', 'compile', 'expand', 'stringify'])(
    '%s accepts 100 levels and rejects 101',
    (api) => {
      expect(() => braces[api](nest(100, kind))).not.toThrow();
      expect(() => braces[api](nest(101, kind))).toThrow(depthError);
    },
  );

  it('rejects 4000 levels within the existing character limit', () => {
    const input = nest(4000, kind);
    expect(input.length).toBeLessThan(10000);
    expect(() => braces(input)).toThrow(depthError);
  });
});

it.each(['compile', 'expand', 'stringify'])(
  '%s rejects over-deep caller-supplied syntax trees',
  (api) => {
    type Node = { type: string; value?: string; nodes?: Node[] };
    let ast: Node = { type: 'text', value: 'a' };
    for (let depth = 0; depth < 101; depth += 1) ast = { type: 'brace', nodes: [ast] };
    expect(() => braces[api]({ type: 'root', nodes: [ast] })).toThrow(depthError);
    expect(() => braces[api](braces.parse('{{a,b},c}'), { maxDepth: 1 })).toThrow(depthError);
  },
);

it.each(['parse', 'compile', 'expand', 'stringify'])(
  '%s preserves the hard cap and permits a lower limit',
  (api) => {
    expect(() => braces[api]('{{a,b},c}', { maxDepth: 1 })).toThrow(depthError);
    expect(() => braces[api]('{{a,b},c}', { maxDepth: 2 })).not.toThrow();
    for (const maxDepth of [101, 100000, Infinity, NaN, '100000', null]) {
      expect(() => braces[api](nest(101), { maxDepth })).toThrow(depthError);
    }
  },
);

it('does not count escaped, quoted, or bracket-literal delimiters as nesting', () => {
  for (const input of [
    '\\{'.repeat(150) + 'x' + '\\}'.repeat(150),
    '\\('.repeat(150) + 'x' + '\\)'.repeat(150),
    `"${nest(150, 'mixed')}"`,
    `'${nest(150, 'mixed')}'`,
    `[${nest(150, 'mixed')}]`,
  ]) {
    expect(() => braces.compile(input)).not.toThrow();
    expect(() => braces.expand(input)).not.toThrow();
  }
});

it('preserves shallow output and the existing stringify parent behavior', () => {
  expect(braces.expand('src/{ui,core}/*.{ts,tsx}')).toEqual([
    'src/ui/*.ts',
    'src/ui/*.tsx',
    'src/core/*.ts',
    'src/core/*.tsx',
  ]);
  expect(braces.expand('{01..03}')).toEqual(['01', '02', '03']);
  const ast = braces.parse('{a}');
  expect(braces.stringify(ast, { escapeInvalid: true })).toBe('{a}');
  expect(braces.compile('src/{ui,core}/**/*.ts')).toBe('src/(ui|core)/**/*.ts');
});

it.each(['braces', 'braceExpand', 'parse'])('protects the actual micromatch %s consumer', (api) => {
  expect(() => micromatch[api](nest(101))).toThrow(depthError);
  expect(() => micromatch[api]('src/{ui,core}/**/*.ts')).not.toThrow();
  expect(micromatch(['a.ts', 'a.js', 'a.txt'], '*.{ts,js}')).toEqual(['a.ts', 'a.js']);
});
