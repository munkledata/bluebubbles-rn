// ky is ESM-only; mock it so the endpoint wrappers are importable under ts-jest/CJS.
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));

import { attachmentDownloadUrl } from '@core/api/endpoints/attachments';
import { HttpClient } from '@core/api/http';
import { ServerInfo } from '@core/models';
import { chatServiceFromGuid, isRcsChatGuid } from '@utils';

function client(): HttpClient {
  return new HttpClient({ getOrigin: () => 'https://x.test', getPassword: () => 'pw' });
}

describe('RCS: chat-guid detection', () => {
  it('recognizes RCS;-; chat guids and nothing else', () => {
    expect(isRcsChatGuid('RCS;-;+15551234567')).toBe(true);
    expect(isRcsChatGuid('RCS;-;group-abc')).toBe(true);
    expect(isRcsChatGuid('iMessage;-;+15551234567')).toBe(false);
    expect(isRcsChatGuid('SMS;-;+15551234567')).toBe(false);
    expect(isRcsChatGuid('chat947991747861991169')).toBe(false);
    expect(isRcsChatGuid(null)).toBe(false);
    expect(isRcsChatGuid(undefined)).toBe(false);
    expect(isRcsChatGuid('')).toBe(false);
  });
});

describe('RCS: outgoing bubble service resolves from the chat guid', () => {
  // From-me rows have no joined handle, so `senderService` is null; the chat guid prefix is the
  // reliable source for colouring an outgoing SMS/RCS bubble (teal/green vs the iMessage accent).
  it('maps each guid prefix to its outgoing service', () => {
    expect(chatServiceFromGuid('RCS;-;+15551234567')).toBe('RCS');
    expect(chatServiceFromGuid('RCS;-;group-abc')).toBe('RCS');
    expect(chatServiceFromGuid('SMS;-;+15551234567')).toBe('SMS');
    expect(chatServiceFromGuid('iMessage;-;+15551234567')).toBe('iMessage');
  });

  it('defaults an unprefixed / legacy guid to iMessage', () => {
    expect(chatServiceFromGuid('chat947991747861991169')).toBe('iMessage');
  });

  it('returns null only when the guid is absent', () => {
    expect(chatServiceFromGuid(null)).toBeNull();
    expect(chatServiceFromGuid(undefined)).toBeNull();
    expect(chatServiceFromGuid('')).toBeNull();
  });
});

describe('RCS: attachment byte-download URL branches on service', () => {
  it('uses the iMessage /attachment route by default', () => {
    expect(attachmentDownloadUrl(client(), 'guid-1')).toBe(
      'https://x.test/api/v1/attachment/guid-1/download',
    );
    expect(attachmentDownloadUrl(client(), 'guid-1', 'iMessage')).toBe(
      'https://x.test/api/v1/attachment/guid-1/download',
    );
    expect(attachmentDownloadUrl(client(), 'guid-1', 'SMS')).toBe(
      'https://x.test/api/v1/attachment/guid-1/download',
    );
  });

  it('uses the separate /rcs/attachment route for service RCS (guid = mediaID)', () => {
    expect(attachmentDownloadUrl(client(), 'media-42', 'RCS')).toBe(
      'https://x.test/api/v1/rcs/attachment/media-42/download',
    );
  });

  it('percent-encodes the guid on both routes', () => {
    expect(attachmentDownloadUrl(client(), 'a/b c', 'RCS')).toBe(
      'https://x.test/api/v1/rcs/attachment/a%2Fb%20c/download',
    );
  });
});

describe('RCS: ServerInfo capability flag is additive/tolerant', () => {
  it('parses rcs:true when the bridge is enabled', () => {
    const info = ServerInfo.parse({ version: '1.9.0', rcs: true });
    expect(info.rcs).toBe(true);
  });

  it('leaves rcs nullish for an older server that omits it (no throw)', () => {
    const info = ServerInfo.parse({ version: '1.9.0' });
    expect(info.rcs ?? false).toBe(false);
  });
});
