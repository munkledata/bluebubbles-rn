import {
  classifyMessageRetraction,
  MAX_RETRACTION_PART_INDEX,
  type MessagePartTopology,
} from '@core/messages/retraction';

const topology = (overrides: Partial<MessagePartTopology> = {}): MessagePartTopology => ({
  complete: true,
  originalPartIndexes: [2, 7, 9],
  currentParts: [
    { index: 2, kind: 'attachment', attachmentGuids: ['attachment-a'] },
    { index: 9, kind: 'text' },
  ],
  attachmentOwnership: [{ attachmentGuid: 'attachment-a', partIndex: 2 }],
  ...overrides,
});

const expectNoExposedContent = (result: ReturnType<typeof classifyMessageRetraction>): void => {
  expect(result.provenVisiblePartIndexes).toEqual(new Set());
  expect(result.provenVisibleTextPartIndexes).toEqual(new Set());
  expect(result.provenVisibleAttachmentGuids).toEqual(new Set());
};

describe('classifyMessageRetraction', () => {
  it('keeps a message intact when it has no retraction signal', () => {
    const result = classifyMessageRetraction({});

    expect(result.state).toBe('intact');
    expect(result.topologyComplete).toBe(false);
    expectNoExposedContent(result);
  });

  it('proves a partial retraction from an exact, non-contiguous part universe', () => {
    const result = classifyMessageRetraction({
      retractedParts: [7, 7],
      topology: topology({
        originalPartIndexes: [2, 7, 9, 2],
        attachmentOwnership: [
          { attachmentGuid: 'attachment-a', partIndex: 2 },
          { attachmentGuid: 'retained-hidden-attachment', partIndex: 7 },
        ],
      }),
    });

    expect(result).toMatchObject({ state: 'partial', topologyComplete: true });
    expect(result.provenVisiblePartIndexes).toEqual(new Set([2, 9]));
    expect(result.provenVisibleTextPartIndexes).toEqual(new Set([9]));
    expect(result.provenVisibleAttachmentGuids).toEqual(new Set(['attachment-a']));
  });

  it('proves a full retraction only when every exact original part is gone', () => {
    const result = classifyMessageRetraction({
      dateRetracted: 1_725_000_000_000,
      retractedParts: [8, 3, 8],
      topology: topology({
        originalPartIndexes: [3, 8],
        currentParts: [],
        attachmentOwnership: [],
      }),
    });

    expect(result).toMatchObject({ state: 'fully-retracted', topologyComplete: true });
    expectNoExposedContent(result);
  });

  it('fails closed for a date-only signal or an invalid retracted-part array', () => {
    const dateOnly = classifyMessageRetraction({
      dateRetracted: 1_725_000_000_000,
      topology: topology({
        originalPartIndexes: [2, 9],
      }),
    });
    const unbounded = classifyMessageRetraction({
      retractedParts: [MAX_RETRACTION_PART_INDEX + 1],
      topology: topology(),
    });
    const malformed = classifyMessageRetraction({
      retractedParts: [7, '9'],
      topology: topology(),
    });
    const tooMany = classifyMessageRetraction({
      retractedParts: Array.from({ length: 129 }, (_, index) => index),
      topology: topology(),
    });

    for (const result of [dateOnly, unbounded, malformed, tooMany]) {
      expect(result).toMatchObject({ state: 'unknown', topologyComplete: false });
      expectNoExposedContent(result);
    }
  });

  it('fails closed for incomplete, overlapping, or non-exact topology', () => {
    const incomplete = classifyMessageRetraction({
      retractedParts: [7],
      topology: topology({ complete: false }),
    });
    const overlap = classifyMessageRetraction({
      retractedParts: [9],
      topology: topology(),
    });
    const missingOriginal = classifyMessageRetraction({
      retractedParts: [7],
      topology: topology({ originalPartIndexes: [2, 7, 9, 10] }),
    });

    for (const result of [incomplete, overlap, missingOriginal]) {
      expect(result).toMatchObject({ state: 'unknown', topologyComplete: false });
      expectNoExposedContent(result);
    }
  });

  it('fails closed for unknown part kinds and contradictory attachment ownership', () => {
    const unknownKind = classifyMessageRetraction({
      retractedParts: [7],
      topology: topology({
        currentParts: [
          { index: 2, kind: 'attachment', attachmentGuids: ['attachment-a'] },
          { index: 9, kind: 'unknown' },
        ],
      }),
    });
    const missingOwner = classifyMessageRetraction({
      retractedParts: [7],
      topology: topology({ attachmentOwnership: [] }),
    });
    const wrongOwner = classifyMessageRetraction({
      retractedParts: [7],
      topology: topology({
        attachmentOwnership: [{ attachmentGuid: 'attachment-a', partIndex: 9 }],
      }),
    });
    const ownerOutsideOriginal = classifyMessageRetraction({
      retractedParts: [7],
      topology: topology({
        attachmentOwnership: [
          { attachmentGuid: 'attachment-a', partIndex: 2 },
          { attachmentGuid: 'not-an-original-part', partIndex: 10 },
        ],
      }),
    });

    for (const result of [unknownKind, missingOwner, wrongOwner, ownerOutsideOriginal]) {
      expect(result).toMatchObject({ state: 'unknown', topologyComplete: false });
      expectNoExposedContent(result);
    }
  });

  it('enforces bounded topology collections and UTF-8 attachment GUID bytes', () => {
    const tooManyOriginalParts = classifyMessageRetraction({
      retractedParts: [127],
      topology: topology({
        originalPartIndexes: Array.from({ length: 129 }, (_, index) => index),
      }),
    });
    const tooManyCurrentParts = classifyMessageRetraction({
      retractedParts: [127],
      topology: topology({
        originalPartIndexes: Array.from({ length: 128 }, (_, index) => index),
        currentParts: Array.from({ length: 129 }, (_, index) => ({ index, kind: 'text' })),
        attachmentOwnership: [],
      }),
    });
    const tooManyAttachmentGuids = Array.from({ length: 257 }, (_, index) => `attachment-${index}`);
    const oversizedUtf8Guid = 'é'.repeat(513);
    const invalidAttachments = [tooManyAttachmentGuids, [oversizedUtf8Guid]].map(
      (attachmentGuids) =>
        classifyMessageRetraction({
          retractedParts: [7],
          topology: topology({
            currentParts: [
              { index: 2, kind: 'attachment', attachmentGuids },
              { index: 9, kind: 'text' },
            ],
            attachmentOwnership: attachmentGuids.map((attachmentGuid) => ({
              attachmentGuid,
              partIndex: 2,
            })),
          }),
        }),
    );

    for (const result of [tooManyOriginalParts, tooManyCurrentParts, ...invalidAttachments]) {
      expect(result).toMatchObject({ state: 'unknown', topologyComplete: false });
      expectNoExposedContent(result);
    }
  });
});
