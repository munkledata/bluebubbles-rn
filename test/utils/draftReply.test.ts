import { DRAFT_KV_PREFIX, DRAFT_REPLY_KV_PREFIX } from '@db/repositories/maintenance';
import { parseDraftReplyTarget, serializeDraftReplyTarget } from '@utils/draftReply';

describe('draft reply target storage', () => {
  it('round-trips a target and stores no message text', () => {
    const value = serializeDraftReplyTarget({ guid: 'msg-1', part: 2 });
    expect(value).toBe('{"v":1,"guid":"msg-1","part":2}');
    expect(parseDraftReplyTarget(value)).toEqual({ guid: 'msg-1', part: 2 });
  });

  it('stores an empty value for "no target"', () => {
    expect(serializeDraftReplyTarget(null)).toBe('');
    expect(parseDraftReplyTarget('')).toBeNull();
    expect(parseDraftReplyTarget(null)).toBeNull();
  });

  it.each([
    'not json',
    '[]',
    'null',
    '{"v":2,"guid":"m","part":0}',
    '{"v":1,"guid":"","part":0}',
    '{"v":1,"guid":5,"part":0}',
    '{"v":1,"guid":"m","part":-1}',
    '{"v":1,"guid":"m","part":1.5}',
    '{"v":1,"guid":"m","part":"0"}',
    '{"v":1,"guid":"m","part":5000}',
    `{"v":1,"guid":"${'x'.repeat(600)}","part":0}`,
  ])('treats a malformed value as no target: %s', (raw) => {
    expect(parseDraftReplyTarget(raw)).toBeNull();
  });

  it('lives inside the draft prefix, so every account wipe of draft.% removes it', () => {
    expect(DRAFT_REPLY_KV_PREFIX.startsWith(DRAFT_KV_PREFIX)).toBe(true);
    // Chat guids always start with a service ("iMessage;", "any;", "RCS;"), never "reply.", so a
    // reply key can't be mistaken for another chat's draft.
  });
});
