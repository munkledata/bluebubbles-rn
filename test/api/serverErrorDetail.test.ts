import {
  MAX_SERVER_ERROR_BODY_BYTES,
  MAX_SERVER_ERROR_DETAIL_BYTES,
  MAX_SERVER_ERROR_DETAIL_CODE_POINTS,
  parseServerErrorDetailBody,
  projectServerErrorDetail,
} from '@core/api/serverErrorDetail';
import { ApiError } from '@core/api/errors';
import { redact } from '@core/secure/redact';

describe('server error detail projection', () => {
  it('accepts only the reviewed nested error.message envelope field', () => {
    expect(
      parseServerErrorDetailBody(
        JSON.stringify({
          status: 422,
          message: 'ignored outer message',
          error: { type: 'send_failed', message: 'Messages rejected this send.' },
        }),
      ),
    ).toBe('Messages rejected this send.');
    expect(parseServerErrorDetailBody(JSON.stringify({ message: 'outer only' }))).toBeUndefined();
    expect(parseServerErrorDetailBody(JSON.stringify({ error: 'plain string' }))).toBeUndefined();
    expect(parseServerErrorDetailBody('{not-json')).toBeUndefined();
  });

  it('normalizes controls and redacts identities, credentials, hosts, and private paths', () => {
    const projected = projectServerErrorDetail(
      '  Could\nnot\tsend\u202e to person@example.com at https://private.example/path-secret-canary?x=abc ' +
        'password=hunter2 file:///Users/alice/Library/a.txt C:\\Users\\alice\\secret.txt  ',
    );
    expect(projected).toContain('Could not send');
    expect(projected).not.toContain('person@example.com');
    expect(projected).not.toContain('private.example');
    expect(projected).not.toContain('path-secret-canary');
    expect(projected).not.toContain('hunter2');
    expect(projected).not.toContain('/Users/alice');
    expect(projected).not.toContain('C:\\Users\\alice');
    expect(projected).not.toContain('\u202e');
    expect(projected).toContain('[redacted]');
    expect(projected).toContain('[redacted URL]');
    expect(projected).toContain('[redacted path]');
  });

  it('rejects stack-like prose instead of persisting a trace', () => {
    expect(
      projectServerErrorDetail('TypeError: secret at send (/Users/alice/send.ts:12:4)'),
    ).toBeUndefined();
  });

  it('enforces both code-point and UTF-8 byte bounds without splitting characters', () => {
    const ascii = projectServerErrorDetail('x'.repeat(MAX_SERVER_ERROR_DETAIL_CODE_POINTS + 50));
    expect(Array.from(ascii ?? '')).toHaveLength(MAX_SERVER_ERROR_DETAIL_CODE_POINTS);

    const emoji = projectServerErrorDetail('😀'.repeat(MAX_SERVER_ERROR_DETAIL_CODE_POINTS));
    expect(new TextEncoder().encode(emoji).byteLength).toBe(MAX_SERVER_ERROR_DETAIL_BYTES);
    expect(Array.from(emoji ?? '')).toHaveLength(MAX_SERVER_ERROR_DETAIL_BYTES / 4);
  });

  it('rejects an error body before parsing when its UTF-8 payload exceeds 4 KiB', () => {
    const body = JSON.stringify({ error: { message: '界'.repeat(MAX_SERVER_ERROR_BODY_BYTES) } });
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(MAX_SERVER_ERROR_BODY_BYTES);
    expect(parseServerErrorDetailBody(body)).toBeUndefined();
  });

  it('rejects an oversized direct source before normalization', () => {
    expect(projectServerErrorDetail('x'.repeat(MAX_SERVER_ERROR_BODY_BYTES + 1))).toBeUndefined();
  });

  it('keeps the UI-only detail out of generic error serialization and redaction', () => {
    const canary = 'private UI detail canary';
    const error = ApiError.fromStatus(422, 'POST /message/text failed', canary);

    expect(error.serverDetail).toBe(canary);
    expect(Object.keys(error)).not.toContain('serverDetail');
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(JSON.stringify(redact(error))).not.toContain(canary);
  });
});
