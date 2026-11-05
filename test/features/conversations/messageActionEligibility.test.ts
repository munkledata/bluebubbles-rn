import {
  currentPartCount,
  imessageReactionPartIndex,
  pressedPartIndex,
  replyTargetPartIndex,
  type MessagePressTarget,
} from '@features/conversations/messageActionEligibility';
import type { EnrichedMessage } from '@features/conversations/useMessages';

const PHOTO = 'att-photo';
const PHOTO_PRESS: MessagePressTarget = { kind: 'attachment', attachmentGuid: PHOTO };
const BODY_PRESS: MessagePressTarget = { kind: 'body' };

function message(topology: unknown, overrides: Partial<EnrichedMessage> = {}): EnrichedMessage {
  return {
    id: 1,
    guid: 'server-guid-1',
    text: 'caption',
    isFromMe: 0,
    senderService: 'iMessage',
    dateRetracted: null,
    reactions: [],
    attachments: [],
    messagePartTopology: topology === undefined ? null : JSON.stringify(topology),
    ...overrides,
  } as unknown as EnrichedMessage;
}

/** A photo (part 0) with its caption (part 1), as Messages stores a captioned picture. */
const PHOTO_AND_CAPTION = {
  complete: true,
  originalPartIndexes: [0, 1],
  currentParts: [
    { index: 0, kind: 'attachment', attachmentGuids: [PHOTO] },
    { index: 1, kind: 'text' },
  ],
  attachmentOwnership: [{ attachmentGuid: PHOTO, partIndex: 0 }],
};

/** The same message after its photo was unsent: only the caption (part 1) is left. */
const CAPTION_ONLY = {
  complete: true,
  originalPartIndexes: [0, 1],
  currentParts: [{ index: 1, kind: 'text' }],
  attachmentOwnership: [{ attachmentGuid: PHOTO, partIndex: 0 }],
};

describe('pressedPartIndex', () => {
  it('maps a pressed photo to its owning part and the body to the one text part', () => {
    const msg = message(PHOTO_AND_CAPTION);
    expect(pressedPartIndex(msg, PHOTO_PRESS)).toBe(0);
    expect(pressedPartIndex(msg, BODY_PRESS)).toBe(1);
    expect(currentPartCount(msg)).toBe(2);
  });

  it('proves nothing without a target, an exact topology, or one matching current part', () => {
    expect(pressedPartIndex(message(PHOTO_AND_CAPTION), undefined)).toBeUndefined();
    // No topology at all, or an incomplete one.
    expect(pressedPartIndex(message(undefined), PHOTO_PRESS)).toBeUndefined();
    expect(
      pressedPartIndex(message({ ...PHOTO_AND_CAPTION, complete: false }), PHOTO_PRESS),
    ).toBeUndefined();
    // An attachment the topology doesn't own.
    expect(
      pressedPartIndex(message(PHOTO_AND_CAPTION), {
        kind: 'attachment',
        attachmentGuid: 'att-other',
      }),
    ).toBeUndefined();
    // A photo whose part was unsent is no longer a current part.
    expect(pressedPartIndex(message(CAPTION_ONLY), PHOTO_PRESS)).toBeUndefined();
    // Two text parts: a press on the body can't say which one.
    const twoTexts = {
      complete: true,
      originalPartIndexes: [0, 1, 2],
      currentParts: [
        { index: 0, kind: 'text' },
        { index: 1, kind: 'attachment', attachmentGuids: [PHOTO] },
        { index: 2, kind: 'text' },
      ],
      attachmentOwnership: [{ attachmentGuid: PHOTO, partIndex: 1 }],
    };
    expect(pressedPartIndex(message(twoTexts), BODY_PRESS)).toBeUndefined();
    expect(pressedPartIndex(message(twoTexts), PHOTO_PRESS)).toBe(1);
  });
});

describe('tapback and reply targets with a pressed part', () => {
  const msg = message(PHOTO_AND_CAPTION);

  it('targets part 0 of a several-part message without the restored part switches', () => {
    expect(imessageReactionPartIndex(msg, false, 0)).toBe(0);
    expect(replyTargetPartIndex(msg, false, 0)).toBe(0);
  });

  it('targets a pressed part above 0 only while the restored part switches are on', () => {
    expect(imessageReactionPartIndex(msg, false, 1)).toBeUndefined();
    expect(replyTargetPartIndex(msg, false, 1)).toBeUndefined();
    expect(imessageReactionPartIndex(msg, true, 1)).toBe(1);
    expect(replyTargetPartIndex(msg, true, 1)).toBe(1);
  });

  it('re-proves the pressed part against the live message', () => {
    // The photo (part 0) was unsent after the long-press: neither action may target it now.
    const live = message(CAPTION_ONLY);
    expect(imessageReactionPartIndex(live, true, 0)).toBeUndefined();
    expect(replyTargetPartIndex(live, true, 0)).toBeUndefined();
    // A part number the message never had.
    expect(imessageReactionPartIndex(msg, true, 5)).toBeUndefined();
    expect(replyTargetPartIndex(msg, true, 5)).toBeUndefined();
  });

  it('never targets an optimistic or SMS copy', () => {
    const temp = message(PHOTO_AND_CAPTION, { guid: 'temp-1' } as Partial<EnrichedMessage>);
    expect(imessageReactionPartIndex(temp, true, 0)).toBeUndefined();
    expect(replyTargetPartIndex(temp, true, 0)).toBeUndefined();
    expect(replyTargetPartIndex(temp, true, 1)).toBeUndefined();
    const sms = message(PHOTO_AND_CAPTION, { senderService: 'SMS' } as Partial<EnrichedMessage>);
    expect(replyTargetPartIndex(sms, true, 0)).toBeUndefined();
    expect(replyTargetPartIndex(sms, true, 1)).toBeUndefined();
  });
});

describe('whole-message rules without a pressed part (unchanged)', () => {
  it('gives a several-part message no tapback and a part-0 reply', () => {
    const msg = message(PHOTO_AND_CAPTION);
    expect(imessageReactionPartIndex(msg, true)).toBeUndefined();
    expect(replyTargetPartIndex(msg, false)).toBe(0);
    expect(replyTargetPartIndex(msg, true)).toBe(0);
  });

  it('targets the one remaining part, above 0 only with the restored switch', () => {
    const msg = message(CAPTION_ONLY);
    expect(imessageReactionPartIndex(msg, false)).toBeUndefined();
    expect(imessageReactionPartIndex(msg, true)).toBe(1);
    expect(replyTargetPartIndex(msg, false)).toBeUndefined();
    expect(replyTargetPartIndex(msg, true)).toBe(1);
  });
});
