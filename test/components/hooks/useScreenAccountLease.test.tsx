import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { renderHook } from '../support/renderWithTheme';

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('useScreenAccountLease', () => {
  it('keeps the lease captured at mount across re-renders', async () => {
    const { result, rerender } = await renderHook(() => useScreenAccountLease());
    const mounted = result.current;

    await rerender({});

    expect(result.current).toBe(mounted);
    expect(mounted.isCurrent()).toBe(true);
  });

  it('stays bound to the account it mounted under after Disconnect and reconnect', async () => {
    const { result } = await renderHook(() => useScreenAccountLease());

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    expect(result.current.isCurrent()).toBe(false);
  });
});
