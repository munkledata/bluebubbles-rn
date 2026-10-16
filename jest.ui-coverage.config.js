const { resolve } = require('node:path');

const baseConfig = require('./jest.config');

const uiRoot = resolve(__dirname, 'src/ui');
// Ratchet floors beyond src/ui (review M004), set on 2026-10-16 one point below the measured value.
// Raise one when coverage improves; never lower one to let a change pass.
//
// src/core, db, services, state, utils and native are not gated yet. Files that both Jest projects
// load are instrumented twice (ts-jest and Babel), and the merged numbers depend on test order:
// two runs of the same code gave src/native 71.8% and 67.9% statements, and 126 files different
// statement totals. A floor there would make CI flaky until each file has one instrumentation.
const directoryFloors = {
  app: { statements: 81, branches: 75, functions: 83, lines: 85 },
  'src/features': { statements: 80, branches: 73, functions: 83, lines: 84 },
};
const criticalFileThreshold = {
  statements: 70,
  branches: 60,
  functions: 60,
  lines: 70,
};

module.exports = {
  ...baseConfig,
  // Measure production UI, the app/ routes and feature hooks (review M004). These two device
  // benchmark harnesses have release-blocked routes; perfRoutes.test.tsx keeps that boundary covered.
  collectCoverageFrom: [
    'src/ui/**/*.{ts,tsx}',
    'app/**/*.{ts,tsx}',
    'src/features/**/*.{ts,tsx}',
    '!src/ui/**/index.ts',
    '!src/ui/conversations/ColdInboxBenchmarkScreen.tsx',
    '!src/ui/conversations/PerfInboxBenchmarkScreen.tsx',
  ],
  coverageReporters: ['text', 'json-summary'],
  coverageThreshold: {
    [`${uiRoot}/`]: {
      statements: 82,
      branches: 76,
      functions: 78,
      lines: 84,
    },
    ...Object.fromEntries(
      Object.entries(directoryFloors).map(([directory, floor]) => [
        `${resolve(__dirname, directory)}/`,
        floor,
      ]),
    ),
    [resolve(uiRoot, 'attachments/AudioAttachment.tsx')]: criticalFileThreshold,
    [resolve(uiRoot, 'conversations/VoiceRecorder.tsx')]: criticalFileThreshold,
    [resolve(uiRoot, 'theme/ThemeStudio.tsx')]: criticalFileThreshold,
    [resolve(uiRoot, 'primitives/TextField.tsx')]: criticalFileThreshold,
  },
};
