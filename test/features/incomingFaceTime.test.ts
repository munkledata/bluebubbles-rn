import { resolveFaceTimeAnswerLink } from '@features/facetime/answerLink';
import type { HttpClient } from '@core/api/http';

// isDevServer() is false under jest (no dev session), so the server path runs.
describe('resolveFaceTimeAnswerLink', () => {
  it('answers then mints + returns the join link', async () => {
    const calls: string[] = [];
    const post = jest.fn((path: string) => {
      calls.push(path);
      if (path.endsWith('/answer')) return Promise.resolve({ answered: true });
      return Promise.resolve({ link: 'https://facetime.apple.com/join#z' });
    });
    const http = { post } as unknown as HttpClient;
    await expect(resolveFaceTimeAnswerLink(http, 'UU-1')).resolves.toBe(
      'https://facetime.apple.com/join#z',
    );
    expect(calls).toEqual(['/facetime/UU-1/answer', '/facetime/link']);
  });

  it('throws when the server returns a non-FaceTime link (scheme guard)', async () => {
    const post = jest.fn((path: string) =>
      path.endsWith('/answer')
        ? Promise.resolve({ answered: true })
        : Promise.resolve({ link: 'intent://evil#Intent;end' }),
    );
    const http = { post } as unknown as HttpClient;
    await expect(resolveFaceTimeAnswerLink(http, 'UU-2')).rejects.toThrow();
  });
});
