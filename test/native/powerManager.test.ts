let mockNative: unknown = null;
jest.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => (name === 'GatorPower' ? mockNative : null),
}));

// eslint-disable-next-line import/first
import { isIgnoringBatteryOptimizations } from '../../src/native/powerManager';

describe('isIgnoringBatteryOptimizations', () => {
  it('passes through Android’s answer', () => {
    mockNative = { isIgnoringBatteryOptimizations: () => true };
    expect(isIgnoringBatteryOptimizations()).toBe(true);
    mockNative = { isIgnoringBatteryOptimizations: () => false };
    expect(isIgnoringBatteryOptimizations()).toBe(false);
  });

  it('says it does not know on a build without the module, a null answer, or a failure', () => {
    mockNative = null;
    expect(isIgnoringBatteryOptimizations()).toBeNull();
    mockNative = { isIgnoringBatteryOptimizations: () => null };
    expect(isIgnoringBatteryOptimizations()).toBeNull();
    mockNative = {
      isIgnoringBatteryOptimizations: () => {
        throw new Error('planted native failure');
      },
    };
    expect(isIgnoringBatteryOptimizations()).toBeNull();
  });
});
