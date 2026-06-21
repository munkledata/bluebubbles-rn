/**
 * Jest configuration for the React-free `core/` layer.
 *
 * The `core/` modules are pure TypeScript with no React Native imports, so they
 * run in plain Node via ts-jest — no device, emulator, or jest-expo needed.
 * UI/component tests (jest-expo + RN Testing Library) are added in a separate
 * project once component work begins.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  moduleNameMapper: {
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
  },
  clearMocks: true,
};
