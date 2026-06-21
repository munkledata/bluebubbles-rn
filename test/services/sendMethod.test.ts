import { chooseSendMethod } from '@/services/send/sendService';

describe('chooseSendMethod', () => {
  it('always uses private-api for effects/replies/edits', () => {
    expect(chooseSendMethod(true, false)).toBe('private-api');
    expect(chooseSendMethod(true, true)).toBe('private-api');
  });

  it('falls back to apple-script for plain text when the Private API is off', () => {
    expect(chooseSendMethod(false, false)).toBe('apple-script');
    expect(chooseSendMethod(false, true)).toBe('private-api');
  });
});
