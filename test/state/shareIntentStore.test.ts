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

describe('shareIntentStore ownership of the held batch', () => {
  it('counts only screens that show the held batch, and releases each exactly once', () => {
    const store = useShareIntentStore.getState();
    store.stageIfEmpty(firstPayload);
    const releaseFirst = store.adopt(FIRST_BATCH);
    const releaseSecond = store.adopt(FIRST_BATCH);
    const releaseOther = store.adopt(SECOND_BATCH);
    expect(useShareIntentStore.getState().owners).toBe(2);

    releaseOther();
    releaseFirst();
    releaseFirst();
    expect(useShareIntentStore.getState().owners).toBe(1);
    releaseSecond();
    expect(useShareIntentStore.getState().owners).toBe(0);
  });

  it('never lets a release for a settled batch touch the newer one', () => {
    const store = useShareIntentStore.getState();
    store.stageIfEmpty(firstPayload);
    const releaseOld = store.adopt(FIRST_BATCH);
    expect(store.clearIf(FIRST_BATCH)).toBe(true);
    expect(useShareIntentStore.getState().owners).toBe(0);

    store.stageIfEmpty({ ...firstPayload, batchId: SECOND_BATCH });
    store.adopt(SECOND_BATCH);
    releaseOld();
    expect(useShareIntentStore.getState().owners).toBe(1);

    store.clear();
    expect(useShareIntentStore.getState().owners).toBe(0);
  });

  it('counts reroute requests and waiting-share notices', () => {
    const before = useShareIntentStore.getState();
    before.requestReroute();
    before.noteWaitingShare();
    before.noteWaitingShare();
    const after = useShareIntentStore.getState();
    expect(after.rerouteRequest).toBe(before.rerouteRequest + 1);
    expect(after.waitingNotice).toBe(before.waitingNotice + 2);
  });
});
