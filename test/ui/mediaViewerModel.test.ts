import type { AttachmentRow } from '@db/repositories';
import {
  activePageAttachment,
  sameMediaSource,
  withRefreshedActivePage,
  type LoadedMedia,
  type MediaSourceGrant,
} from '@ui/attachments/mediaViewerModel';

function row(guid: string, localPath: string | null = `file:///docs/${guid}.jpg`): AttachmentRow {
  return {
    id: 1,
    guid,
    messageId: 1,
    mimeType: 'image/jpeg',
    transferName: `${guid}.jpg`,
    totalBytes: 1000,
    height: 100,
    width: 100,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath,
    service: null,
  };
}

/** Photo "b" opened from a three-photo chat gallery. */
function loaded(overrides: Partial<LoadedMedia> = {}): LoadedMedia {
  return {
    routeGuid: 'b',
    routeLifetime: 1,
    attachment: row('b'),
    gallery: { items: [row('a'), row('b'), row('c')], index: 1 },
    pageIndex: 1,
    pageLifetime: 4,
    pageStatus: 'checking',
    ...overrides,
  };
}

const SOURCE: MediaSourceGrant = {
  routeGuid: 'b',
  routeLifetime: 1,
  pageLifetime: 4,
  attachmentGuid: 'b',
  localPath: 'file:///docs/b.jpg',
  mimeType: 'image/jpeg',
};

describe('sameMediaSource', () => {
  it('matches only when the page, lifetimes and file all match', () => {
    expect(sameMediaSource(SOURCE, { ...SOURCE })).toBe(true);
    const changes: Partial<MediaSourceGrant>[] = [
      { routeGuid: 'other' },
      { routeLifetime: 2 },
      { pageLifetime: 5 },
      { attachmentGuid: 'other' },
      { localPath: null },
      { mimeType: 'image/png' },
    ];
    for (const change of changes) {
      expect(sameMediaSource(SOURCE, { ...SOURCE, ...change })).toBe(false);
    }
  });
});

describe('activePageAttachment', () => {
  it('returns the gallery item at the page index', () => {
    expect(activePageAttachment(loaded({ pageIndex: 2 }))?.guid).toBe('c');
  });

  it('never falls back to the opened attachment from an invalid gallery index', () => {
    expect(activePageAttachment(loaded({ pageIndex: 7 }))).toBeNull();
  });

  it('returns the opened attachment when there is no gallery', () => {
    expect(activePageAttachment(loaded({ gallery: null, pageIndex: 0 }))?.guid).toBe('b');
  });
});

describe('withRefreshedActivePage', () => {
  it('replaces only the active gallery row, marks the page ready, and leaves the input alone', () => {
    const before = loaded();
    const fresh = row('b', 'file:///docs/b-new.jpg');

    const after = withRefreshedActivePage(before, fresh);

    expect(after.pageStatus).toBe('ready');
    expect(after.gallery?.items.map((item) => item.localPath)).toEqual([
      'file:///docs/a.jpg',
      'file:///docs/b-new.jpg',
      'file:///docs/c.jpg',
    ]);
    expect(after.attachment).toBe(fresh);
    expect(before.pageStatus).toBe('checking');
    expect(before.gallery?.items[1]?.localPath).toBe('file:///docs/b.jpg');
  });

  it('keeps the opened attachment when the refreshed page is a different photo', () => {
    const before = loaded({ pageIndex: 2 });

    const after = withRefreshedActivePage(before, row('c', 'file:///docs/c-new.jpg'));

    expect(after.attachment).toBe(before.attachment);
    expect(after.gallery?.items[2]?.localPath).toBe('file:///docs/c-new.jpg');
  });

  it('refreshes the opened attachment when there is no gallery', () => {
    const fresh = row('b', 'file:///docs/b-new.jpg');

    const after = withRefreshedActivePage(loaded({ gallery: null, pageIndex: 0 }), fresh);

    expect(after.gallery).toBeNull();
    expect(after.attachment).toBe(fresh);
    expect(after.pageStatus).toBe('ready');
  });
});
