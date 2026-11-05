const mockPlatform = { OS: 'android' };
let mockIgnoring: boolean | null = null;
jest.mock('react-native', () => ({ Platform: mockPlatform }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: null } }));
jest.mock('@/native/powerManager', () => ({
  isIgnoringBatteryOptimizations: () => mockIgnoring,
}));

// eslint-disable-next-line import/first
import { batteryOptimizationNote, getBatteryOptimizationStatus } from '@/services/battery';

beforeEach(() => {
  mockPlatform.OS = 'android';
  mockIgnoring = null;
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
