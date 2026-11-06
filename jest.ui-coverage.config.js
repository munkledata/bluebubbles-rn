const { resolve } = require('node:path');

const baseConfig = require('./jest.config');

const uiRoot = resolve(__dirname, 'src/ui');
// Ratchet floors beyond src/ui (review M004), set on 2026-10-16 and re-measured on 2026-11-06, each one
// point below the measured value (measured: app 85.21/79.49/86.84/88.95, src/features 83.50/79.67/85.87/86.79).
// Raise one when coverage improves; never lower one to let a change pass.
//
// src/core, db, services, state, utils and native are not gated yet. Files that both Jest projects
// load are instrumented twice (ts-jest and Babel), and the merged numbers depend on test order:
// two runs of the same code gave src/native 71.8% and 67.9% statements, and 126 files different
// statement totals. A floor there would make CI flaky until each file has one instrumentation.
const directoryFloors = {
  app: { statements: 84, branches: 78, functions: 85, lines: 87 },
  'src/features': { statements: 82, branches: 78, functions: 84, lines: 85 },
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
      statements: 88,
      branches: 83,
      functions: 89,
      lines: 91,
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
