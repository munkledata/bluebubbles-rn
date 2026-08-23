import config from '../../app.config';

const easConfig = require('../../eas.json') as {
  build?: Record<string, Record<string, unknown>>;
};
const packageJson = require('../../package.json') as {
  dependencies?: Record<string, string>;
};

describe('EAS update configuration', () => {
  it('does not advertise OTA channels while expo-updates is not installed', () => {
    expect(packageJson.dependencies?.['expo-updates']).toBeUndefined();
    expect(config).not.toHaveProperty('runtimeVersion');
    expect(config).not.toHaveProperty('updates');
    for (const profile of Object.values(easConfig.build ?? {})) {
      expect(profile).not.toHaveProperty('channel');
      expect(profile).not.toHaveProperty('runtimeVersion');
    }
  });
});
