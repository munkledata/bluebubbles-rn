const { resolve } = require('node:path');

const baseConfig = require('./jest.config');

const uiRoot = resolve(__dirname, 'src/ui');
const criticalFileThreshold = {
  statements: 70,
  branches: 60,
  functions: 60,
  lines: 70,
};

module.exports = {
  ...baseConfig,
  collectCoverageFrom: ['src/ui/**/*.{ts,tsx}', '!src/ui/**/index.ts'],
  coverageReporters: ['text', 'json-summary'],
  coverageThreshold: {
    [`${uiRoot}/`]: {
      statements: 82,
      branches: 76,
      functions: 78,
      lines: 84,
    },
    [resolve(uiRoot, 'attachments/AudioAttachment.tsx')]: criticalFileThreshold,
    [resolve(uiRoot, 'conversations/VoiceRecorder.tsx')]: criticalFileThreshold,
    [resolve(uiRoot, 'theme/ThemeStudio.tsx')]: criticalFileThreshold,
    [resolve(uiRoot, 'primitives/TextField.tsx')]: criticalFileThreshold,
  },
};
