// Flat ESLint config (ESLint 9) for the Expo SDK 57 app.
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
    files: ['app/**/*.{js,jsx,ts,tsx}', 'src/**/*.{js,jsx,ts,tsx}'],
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
  {
    files: ['index.js', 'app/**/*.{js,jsx,ts,tsx}', 'src/**/*.{js,jsx,ts,tsx}'],
    ignores: ['src/services/notifications/nativeNotificationAdapter.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native-notify-kit',
              message: 'Import the owned nativeNotificationAdapter instead.',
            },
          ],
          patterns: [
            {
              group: ['react-native-notify-kit/*'],
              message: 'Import the owned nativeNotificationAdapter instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^react-native-notify-kit(?:\\/|$)/]',
          message: 'Import the owned nativeNotificationAdapter instead.',
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^react-native-notify-kit(?:\\/|$)/]",
          message: 'Require the owned nativeNotificationAdapter instead.',
        },
        // Database ownership (see src/db/types.ts). The compiler already rejects a nested
        // transaction through the ReadDb/WriteDb split; these three catch the shapes types cannot.
        {
          // `> :function` = inside the callback argument, not the handle argument before it.
          selector:
            'CallExpression[callee.name=/^withDb(Transaction|WriteLock)$/] > :function CallExpression[callee.name=/^withDb(Transaction|WriteLock)$/]',
          message:
            'A transaction or write lock opened inside another waits forever on its own caller. Call the *WithinTransaction twin with the context instead.',
        },
        {
          selector:
            'CallExpression[callee.name=/^withDb(Transaction|WriteLock)$/] > :function CallExpression[callee.name=/^(getDatabase|getRawDatabase|ensureDatabase)$/]',
          message:
            'Use the tx parameter inside a transaction or write-lock callback; do not fetch another handle.',
        },
        {
          selector: "CallExpression[callee.property.name='transaction']",
          message:
            "Drizzle's own transaction() nests BEGIN on the shared connection. Use withDbTransaction.",
        },
        // The three shapes the 2026-11-06 scanner triage found that neither the types nor the rules
        // above catch (G1–G3 in gator-scanner-invariant-triage-2026-11-06.md).
        {
          // G1: a detached owner. The caller continues before the write commits, and a rollback
          // becomes an unhandled rejection.
          selector:
            "UnaryExpression[operator='void'] > CallExpression[callee.name=/^(withDbTransaction|withDbWriteLock|runInTransactionContext)$/]",
          message:
            'await or return the transaction; a detached one commits after its caller moved on and turns a rollback into an unhandled rejection.',
        },
        {
          selector:
            'ExpressionStatement > CallExpression[callee.name=/^(withDbTransaction|withDbWriteLock|runInTransactionContext)$/]',
          message:
            'await or return the transaction; a detached one commits after its caller moved on and turns a rollback into an unhandled rejection.',
        },
        {
          // G2 (approximation): a function already holding the write handle or the transaction
          // context must not fetch another handle; opening a transaction on it would nest.
          // esquery cannot look into a parameter's type from :has(), so the first four parameter
          // positions are spelled out; the handle is almost always first and the context second.
          selector:
            ':function[params.0.typeAnnotation.typeAnnotation.typeName.name=/^(WriteDb|DbTransactionContext)$/] CallExpression[callee.name=/^(getDatabase|getRawDatabase|ensureDatabase)$/], :function[params.1.typeAnnotation.typeAnnotation.typeName.name=/^(WriteDb|DbTransactionContext)$/] CallExpression[callee.name=/^(getDatabase|getRawDatabase|ensureDatabase)$/], :function[params.2.typeAnnotation.typeAnnotation.typeName.name=/^(WriteDb|DbTransactionContext)$/] CallExpression[callee.name=/^(getDatabase|getRawDatabase|ensureDatabase)$/], :function[params.3.typeAnnotation.typeAnnotation.typeName.name=/^(WriteDb|DbTransactionContext)$/] CallExpression[callee.name=/^(getDatabase|getRawDatabase|ensureDatabase)$/]',
          message:
            'This function already holds the transaction (WriteDb/DbTransactionContext). Use that handle; fetching another one and opening a transaction on it nests.',
        },
        {
          // G3: the raw driver client behind a WriteDb bypasses the adapter and the write lock.
          selector:
            "MemberExpression[property.name='$client'], MemberExpression[property.name='client'][object.property.name='session']",
          message:
            'The raw driver client bypasses the Drizzle adapter and the write lock. Stay on the WriteDb API.',
        },
      ],
    },
  },
];
