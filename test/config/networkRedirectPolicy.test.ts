describe('authenticated network redirect policy', () => {
  const original = process.env.EXPO_PUBLIC_USE_RN_FETCH;

  afterEach(() => {
    jest.resetModules();
    if (original === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
    else process.env.EXPO_PUBLIC_USE_RN_FETCH = original;
  });

  it.each(['1', 'true', ' TRUE '])(
    'fails Expo config when EXPO_PUBLIC_USE_RN_FETCH=%p',
    (value) => {
      jest.resetModules();
      process.env.EXPO_PUBLIC_USE_RN_FETCH = value;

      expect(() => require('../../app.config')).toThrow(
        'EXPO_PUBLIC_USE_RN_FETCH must remain disabled',
      );
    },
  );

  it.each([undefined, '0', 'false'])('accepts the disabled value %p', (value) => {
    jest.resetModules();
    if (value === undefined) delete process.env.EXPO_PUBLIC_USE_RN_FETCH;
    else process.env.EXPO_PUBLIC_USE_RN_FETCH = value;

    expect(() => require('../../app.config')).not.toThrow();
  });
});
