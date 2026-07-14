/**
 * Jest configuration — two projects.
 *
 * Project 'node':  the React-free `core`/`db`/`services` layer. Pure TypeScript
 *   with no React Native imports, run in plain Node via ts-jest — no device,
 *   emulator, or jest-expo needed. Tests are the `.test.ts` files under test/
 *   and src/. This is the original config, unchanged in behavior.
 *
 * Project 'components':  UI/component tests via jest-expo + React Native Testing
 *   Library. Tests are the `.test.tsx` files under test/components. Uses
 *   babel.config.js (babel-preset-expo) to transform RN/Expo source.
 *
 * The `.test.ts` vs `.test.tsx` extension is the routing rule between projects.
 */

// Path-alias mapper shared by both projects (mirrors tsconfig.json paths).
const moduleNameMapper = {
  // Native module: swap for a runtime stub (types still resolve to the real .d.ts).
  '^@notifee/react-native$': '<rootDir>/test/__mocks__/notifee.ts',
  '^@core$': '<rootDir>/src/core/index.ts',
  '^@db$': '<rootDir>/src/db/schema.ts',
  '^@ui$': '<rootDir>/src/ui/index.ts',
  '^@utils$': '<rootDir>/src/utils/index.ts',
  '^@/(.*)$': '<rootDir>/src/$1',
  '^@core/(.*)$': '<rootDir>/src/core/$1',
  '^@db/(.*)$': '<rootDir>/src/db/$1',
  '^@ui/(.*)$': '<rootDir>/src/ui/$1',
  '^@state/(.*)$': '<rootDir>/src/state/$1',
  '^@features/(.*)$': '<rootDir>/src/features/$1',
  '^@native/(.*)$': '<rootDir>/src/native/$1',
  '^@utils/(.*)$': '<rootDir>/src/utils/$1',
};

module.exports = {
  projects: [
    {
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/src', '<rootDir>/test'],
      testMatch: ['**/*.test.ts'],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
      },
      moduleNameMapper,
      clearMocks: true,
    },
    {
      displayName: 'components',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/test/components/**/*.test.tsx'],
      setupFilesAfterEnv: ['<rootDir>/test/components/support/setup.ts'],
      moduleNameMapper,
      clearMocks: true,
    },
  ],
};
