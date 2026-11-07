const mockPlatform = { OS: 'android' };
let mockIgnoring: boolean | null = null;
jest.mock('react-native', () => ({ Platform: mockPlatform }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));
jest.mock('@/native/powerManager', () => ({
  isIgnoringBatteryOptimizations: () => mockIgnoring,
}));
const mockStartActivity = jest.fn<Promise<void>, [string, unknown?]>();
jest.mock('expo-intent-launcher', () => ({
  ActivityAction: {
    APPLICATION_DETAILS_SETTINGS: 'APPLICATION_DETAILS_SETTINGS',
    IGNORE_BATTERY_OPTIMIZATION_SETTINGS: 'IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
  },
  startActivityAsync: (action: string, params?: unknown) => mockStartActivity(action, params),
}));

// eslint-disable-next-line import/first
import {
  batteryOptimizationNote,
  getBatteryOptimizationStatus,
  requestDisableBatteryOptimization,
} from '@/services/battery';

beforeEach(() => {
  mockPlatform.OS = 'android';
  mockIgnoring = null;
  mockStartActivity.mockReset();
  mockStartActivity.mockResolvedValue(undefined);
});

describe('getBatteryOptimizationStatus', () => {
  it('reads Android’s answer each time it is asked', () => {
    mockIgnoring = true;
    expect(getBatteryOptimizationStatus()).toBe('unrestricted');
    mockIgnoring = false;
    expect(getBatteryOptimizationStatus()).toBe('optimized');
  });

  it('is unknown off Android or when Android gives no answer', () => {
    expect(getBatteryOptimizationStatus()).toBe('unknown');
    mockPlatform.OS = 'ios';
    mockIgnoring = true;
    expect(getBatteryOptimizationStatus()).toBe('unknown');
  });
});

describe('batteryOptimizationNote', () => {
  it('explains each known status and says nothing it can’t back up', () => {
    expect(batteryOptimizationNote('unrestricted')).toMatch(/^Battery: Unrestricted\./);
    expect(batteryOptimizationNote('optimized')).toMatch(/may delay notifications/);
    expect(batteryOptimizationNote('optimized')).toMatch(/“Unrestricted”/);
    expect(batteryOptimizationNote('unknown')).toBeNull();
  });
});

describe('requestDisableBatteryOptimization', () => {
  it('opens Gator’s own App info page, where Battery is one tap away', async () => {
    await expect(requestDisableBatteryOptimization()).resolves.toBe(true);
    expect(mockStartActivity).toHaveBeenCalledTimes(1);
    expect(mockStartActivity).toHaveBeenCalledWith('APPLICATION_DETAILS_SETTINGS', {
      data: 'package:com.bluegreengatorapps.messages',
    });
  });

  it('falls back to the general battery-optimization list when App info will not open', async () => {
    mockStartActivity.mockRejectedValueOnce(new Error('no activity'));
    await expect(requestDisableBatteryOptimization()).resolves.toBe(true);
    expect(mockStartActivity).toHaveBeenLastCalledWith(
      'IGNORE_BATTERY_OPTIMIZATION_SETTINGS',
      undefined,
    );
  });

  it('does nothing off Android', async () => {
    mockPlatform.OS = 'ios';
    await expect(requestDisableBatteryOptimization()).resolves.toBe(false);
    expect(mockStartActivity).not.toHaveBeenCalled();
  });
});
