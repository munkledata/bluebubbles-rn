import type { ExpoConfig } from 'expo/config';

describe('native Google Maps configuration', () => {
  const originalKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  const originalProfile = process.env.EAS_BUILD_PROFILE;

  function restoreEnvironment(): void {
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_ANDROID_API_KEY;
    else process.env.GOOGLE_MAPS_ANDROID_API_KEY = originalKey;
    if (originalProfile === undefined) delete process.env.EAS_BUILD_PROFILE;
    else process.env.EAS_BUILD_PROFILE = originalProfile;
  }

  function loadConfig(): ExpoConfig {
    jest.resetModules();
    return jest.requireActual<{ default: ExpoConfig }>('../../app.config').default;
  }

  afterEach(() => {
    restoreEnvironment();
    jest.resetModules();
  });

  it('fails every EAS build before native generation when the Maps key is missing', () => {
    delete process.env.GOOGLE_MAPS_ANDROID_API_KEY;
    process.env.EAS_BUILD_PROFILE = 'production';

    expect(loadConfig).toThrow('GOOGLE_MAPS_ANDROID_API_KEY is required for every EAS build');
  });

  it('injects the controlled key only into the native map plugin', () => {
    const controlledTestKey = `AIza${'B'.repeat(35)}`;
    process.env.GOOGLE_MAPS_ANDROID_API_KEY = controlledTestKey;
    process.env.EAS_BUILD_PROFILE = 'preview';
    const config = loadConfig();
    const mapsPlugins = (config.plugins ?? []).filter(
      (plugin) => Array.isArray(plugin) && plugin[0] === 'react-native-maps',
    );

    expect(mapsPlugins).toEqual([
      ['react-native-maps', { androidGoogleMapsApiKey: controlledTestKey }],
    ]);
    expect(config.extra).not.toHaveProperty('googleMapsApiKey');
  });

  it('fails before native generation when a configured Maps key is malformed', () => {
    process.env.GOOGLE_MAPS_ANDROID_API_KEY = 'not-a-google-api-key';
    process.env.EAS_BUILD_PROFILE = 'production';

    expect(loadConfig).toThrow(
      'GOOGLE_MAPS_ANDROID_API_KEY must have a valid Google API key shape',
    );
  });

  it('blocks phone-location permissions because Find My uses server-provided coordinates', () => {
    delete process.env.EAS_BUILD_PROFILE;
    const blocked = loadConfig().android?.blockedPermissions ?? [];

    expect(blocked).toEqual(
      expect.arrayContaining([
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.FOREGROUND_SERVICE_LOCATION',
      ]),
    );
  });
});
