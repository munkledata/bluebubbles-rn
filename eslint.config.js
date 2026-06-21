// Flat ESLint config (ESLint 9) for the Expo SDK 56 app.
// https://docs.expo.dev/guides/using-eslint/
const expoConfig = require('eslint-config-expo/flat');
const eslintConfigPrettier = require('eslint-config-prettier');

const expo = Array.isArray(expoConfig) ? expoConfig : [expoConfig];

module.exports = [
  ...expo,
  // Prettier owns formatting — turn off any stylistic rules that would conflict.
  eslintConfigPrettier,
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      'android/**',
      'ios/**',
      'dist/**',
      'coverage/**',
      'babel.config.js',
      'metro.config.js',
      'eslint.config.js',
    ],
  },
  {
    rules: {
      // Error so CI actually guards this class: the genuinely-intentional cases are each
      // annotated with an eslint-disable at the call site, so a NEW unjustified missing-dep
      // fails the build (the whole point of CS-4).
      'react-hooks/exhaustive-deps': 'error',
      // Off: flags the standard `useRef(new Animated.Value(0)).current` idiom used throughout
      // the effects/animation views — a valid RN pattern, not a bug.
      'react-hooks/refs': 'off',
      // Advisory: occasionally a valid "derive state from props/data" effect.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      // Off: the codebase intentionally pairs a zod schema `const X` with `type X = z.infer<...>`
      // (value + type share a name by design — different namespaces, not a real redeclare).
      '@typescript-eslint/no-redeclare': 'off',
      // Off: `T[]` vs `Array<T>` is a Prettier-adjacent style choice, not correctness.
      '@typescript-eslint/array-type': 'off',
      // Error: catch genuinely unused symbols (underscore-prefixed are intentional throwaways).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
