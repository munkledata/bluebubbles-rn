import { newChatPathForIMessageLink } from '@utils/imessageLink';
import { redirectSystemPath } from '../../app/+native-intent';

const target = (path: string | null): Record<string, string | undefined> | null => {
  if (path == null) return null;
  const query = path.split('?')[1] ?? '';
  const params: Record<string, string | undefined> = {};
  for (const part of query.split('&')) {
    const [k, v] = part.split('=');
    if (k) params[k] = decodeURIComponent(v ?? '');
  }
  return { route: path.split('?')[0], ...params };
};

describe('newChatPathForIMessageLink', () => {
  it('opens New Message for a phone number, with or without slashes', () => {
    expect(target(newChatPathForIMessageLink('imessage://+15551234567'))).toEqual({
      route: '/new-chat',
      to: '+15551234567',
    });
    expect(target(newChatPathForIMessageLink('imessage:+15551234567'))).toEqual({
      route: '/new-chat',
      to: '+15551234567',
    });
    expect(target(newChatPathForIMessageLink('IMESSAGE://(555) 123-4567'))?.to).toBe(
      '(555) 123-4567',
    );
  });

  it('accepts an email and percent-encoding', () => {
    expect(target(newChatPathForIMessageLink('imessage://pat%40example.com'))?.to).toBe(
      'pat@example.com',
    );
  });

  it('pre-fills the body from ?body= or BlueBubbles-style &body=', () => {
    expect(target(newChatPathForIMessageLink('imessage://+15551234567?body=Hi%20there'))).toEqual({
      route: '/new-chat',
      to: '+15551234567',
      body: 'Hi there',
    });
    expect(target(newChatPathForIMessageLink('imessage://+15551234567&body=Hi+there'))?.body).toBe(
      'Hi there',
    );
  });

  it('bounds and cleans the body', () => {
    const long = 'a'.repeat(3000); // inside the 4096-character link cap, over the 2000 body cap
    expect(
      target(newChatPathForIMessageLink(`imessage:+15551234567?body=${long}`))?.body,
    ).toHaveLength(2000);
    expect(target(newChatPathForIMessageLink('imessage:+15551234567?body=a%00b%0Ac'))?.body).toBe(
      'ab\nc',
    );
    expect(
      target(newChatPathForIMessageLink('imessage:+15551234567?body=%20%20'))?.body,
    ).toBeUndefined();
  });

  it('refuses anything that is not one plausible address', () => {
    for (const url of [
      'imessage://',
      'imessage://hello',
      'imessage://123',
      'imessage://+15551234567,+15557654321',
      'imessage://a%00b@example.com',
      'imessage://%E0%A4%A',
      `imessage://${'1'.repeat(300)}`,
      `imessage://+15551234567?body=${'x'.repeat(5000)}`,
      'https://example.com',
      'gator://chat/abc',
      'sms:+15551234567',
    ]) {
      expect(newChatPathForIMessageLink(url)).toBeNull();
    }
  });
});

describe('+native-intent redirectSystemPath', () => {
  it('rewrites imessage links and passes every other link through unchanged', () => {
    expect(redirectSystemPath({ path: 'imessage://+15551234567', initial: true })).toBe(
      '/new-chat?to=%2B15551234567',
    );
    for (const path of ['gator://expo-development-client/?url=x', '/chat/abc', 'imessage://bad']) {
      expect(redirectSystemPath({ path, initial: false })).toBe(path);
    }
  });
});
