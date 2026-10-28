import { renderHook } from '@testing-library/react-native';
import { useShareIntentStore } from '@state/shareIntentStore';
import { useShareBatchOwnership } from '@ui/hooks/useShareBatchOwnership';

const BATCH = '1720000000000-1-0123456789abcdef';

beforeEach(() => {
  useShareIntentStore.getState().clear();
  useShareIntentStore.getState().stageIfEmpty({
    batchId: BATCH,
    createdAtMs: 1_720_000_000_000,
    text: null,
    files: [],
    targetToken: null,
  });
});

describe('useShareBatchOwnership', () => {
  it('owns the held batch exactly while mounted', async () => {
    const view = await renderHook(() => useShareBatchOwnership(BATCH));
    expect(useShareIntentStore.getState().owners).toBe(1);

    await view.unmount();
    expect(useShareIntentStore.getState().owners).toBe(0);
  });

  it('owns nothing for a screen that holds no batch', async () => {
    const view = await renderHook(() => useShareBatchOwnership(null));
    expect(useShareIntentStore.getState().owners).toBe(0);
    await view.unmount();
    expect(useShareIntentStore.getState().owners).toBe(0);
  });
});
