import config from '../../app.config';

describe('dark-only native appearance', () => {
  it('forces dark system appearance before the React tree mounts', () => {
    expect(config.userInterfaceStyle).toBe('dark');
    expect(config.backgroundColor).toBe('#000000');
    expect(config.plugins).toContainEqual([
      'expo-navigation-bar',
      { enforceContrast: false, style: 'light' },
    ]);
  });
});
