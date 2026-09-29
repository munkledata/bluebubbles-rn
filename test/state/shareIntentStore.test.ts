import { useShareIntentStore } from '@state/shareIntentStore';

const FIRST_BATCH = '1720000000000-1-0123456789abcdef';
const SECOND_BATCH = '1720000000001-2-fedcba9876543210';

const firstPayload = {
  batchId: FIRST_BATCH,
  createdAtMs: 1_720_000_000_000,
  text: 'shared note',
  files: [
    {
      uri: `file:///data/user/0/gator/cache/shared-in/files/${FIRST_BATCH}/00-note.pdf`,
      name: 'note.pdf',
      mimeType: 'application/pdf',
      size: 10,
      origin: 'share' as const,
    },
  ],
  targetToken: `gator-share-v2-${'A'.repeat(43)}`,
};

beforeEach(() => {
  useShareIntentStore.getState().clear();
  useShareIntentStore.getState().clearFailureReason();
});

describe('shareIntentStore exact native-batch handoff', () => {
  it('stages one complete native claim only while the handoff is empty', () => {
    expect(useShareIntentStore.getState().stageIfEmpty(firstPayload)).toBe(true);
    expect(useShareIntentStore.getState()).toMatchObject(firstPayload);

    expect(
      useShareIntentStore.getState().stageIfEmpty({
        batchId: SECOND_BATCH,
        createdAtMs: 1_720_000_000_001,
        text: 'newer share',
        files: [],
        targetToken: null,
      }),
    ).toBe(false);
    expect(useShareIntentStore.getState()).toMatchObject(firstPayload);
  });

  it('refuses a stale clear and clears only the exact claimed batch', () => {
    useShareIntentStore.getState().stageIfEmpty(firstPayload);

    expect(useShareIntentStore.getState().clearIf(SECOND_BATCH)).toBe(false);
    expect(useShareIntentStore.getState()).toMatchObject(firstPayload);

    expect(useShareIntentStore.getState().clearIf(FIRST_BATCH)).toBe(true);
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: null,
      text: null,
      files: [],
      targetToken: null,
    });
  });

  it('keeps a rejection receipt separate from the claimed content', () => {
    useShareIntentStore.getState().stageIfEmpty(firstPayload);
    useShareIntentStore.getState().setFailureReason('permission');

    expect(useShareIntentStore.getState().failureReason).toBe('permission');
    expect(useShareIntentStore.getState()).toMatchObject(firstPayload);

    useShareIntentStore.getState().clearFailureReason();
    expect(useShareIntentStore.getState().failureReason).toBeNull();
    expect(useShareIntentStore.getState()).toMatchObject(firstPayload);
  });

  it('supports an explicit administrative reset without acknowledging native ownership', () => {
    useShareIntentStore.getState().stageIfEmpty(firstPayload);

    useShareIntentStore.getState().clear();
    expect(useShareIntentStore.getState()).toMatchObject({
      batchId: null,
      text: null,
      files: [],
      targetToken: null,
    });
  });
});
