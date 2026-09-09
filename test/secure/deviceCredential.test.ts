import { isScopedDeviceCredential } from '@core/secure';

describe('scoped device credential classification', () => {
  it('accepts only the complete server-issued wire format', () => {
    expect(isScopedDeviceCredential(`bbd_device_v1_${'A_-b'.repeat(10)}Abc`)).toBe(true);
  });

  it.each([
    null,
    undefined,
    'ordinary-shared-password',
    `bbd_device_v1_${'a'.repeat(42)}`,
    `bbd_device_v1_${'a'.repeat(44)}`,
    `bbd_device_v1_${'a'.repeat(42)}=`,
  ])('rejects a non-token value without guessing: %p', (value) => {
    expect(isScopedDeviceCredential(value)).toBe(false);
  });
});
