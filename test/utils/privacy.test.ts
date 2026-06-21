import { redactMessageText, redactPreview, redactTitle } from '@utils';

describe('privacy redaction helpers', () => {
  it('pass through unchanged when not redacted', () => {
    expect(redactPreview('hi there', false)).toBe('hi there');
    expect(redactTitle('Craig', false)).toBe('Craig');
    expect(redactMessageText('secret', false)).toBe('secret');
  });

  it('mask content with generic placeholders when redacted', () => {
    expect(redactPreview('hi there', true)).toBe('Message');
    expect(redactTitle('Craig', true)).toBe('Contact');
    expect(redactMessageText('secret', true)).toBe('Message');
  });

  it('preserve empty/null so layout does not shift', () => {
    expect(redactPreview('', true)).toBe('');
    expect(redactTitle('', true)).toBe('');
    expect(redactMessageText(null, true)).toBe('');
    expect(redactMessageText(undefined, false)).toBe('');
  });
});
