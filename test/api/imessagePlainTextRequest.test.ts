import {
  requireIMessagePlainTextRequest,
  UnsupportedIMessageTextError,
} from '@core/api/endpoints/messages';

const valid = { chatGuid: 'any;-;+15551234567', message: 'hello', tempGuid: 'temp-abc12345' };

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('requireIMessagePlainTextRequest', () => {
  it('accepts an ordinary text', () => {
    expect(() => requireIMessagePlainTextRequest(valid)).not.toThrow();
  });

  it.each([
    ['an inline-attachment placeholder', 'see ￼ attached'],
    ['a control character', 'bell \u0007'],
    ['more than 64 KiB', 'a'.repeat(65_537)],
    ['a broken character', 'half \ud83d'],
    ['only whitespace', '   '],
  ])('refuses text with %s as unsupported text, not a connection problem', (_label, message) => {
    expect(thrownBy(() => requireIMessagePlainTextRequest({ ...valid, message }))).toBeInstanceOf(
      UnsupportedIMessageTextError,
    );
  });

  it('keeps a malformed conversation id an internal error', () => {
    const error = thrownBy(() =>
      requireIMessagePlainTextRequest({ ...valid, chatGuid: 'SMS;-;+15551234567' }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnsupportedIMessageTextError);
  });
});
