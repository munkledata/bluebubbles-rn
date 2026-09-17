import { chooseSendMethod } from '@/services/send/sendService';

describe('chooseSendMethod', () => {
  it('rejects retired effects/replies/edits even when stale state advertises Private API', () => {
    expect(() => chooseSendMethod(true)).toThrow('were retired in this release');
  });

  it('always uses apple-script for plain text', () => {
    expect(chooseSendMethod(false)).toBe('apple-script');
  });
});
