// The module imports expo-file-system/legacy (native) for the upload path; stub it so the
// http-only removeGroupIcon can be tested in the node project.
jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
}));

// eslint-disable-next-line import/first
import { removeGroupIcon } from '@/services/chat/groupIcon';
// eslint-disable-next-line import/first
import type { HttpClient } from '@core/api/http';

describe('groupIcon', () => {
  it('removeGroupIcon DELETEs /chat/:guid/icon (guid encoded)', async () => {
    const del = jest.fn(() => Promise.resolve({}));
    const http = { delete: del } as unknown as HttpClient;
    await removeGroupIcon(http, 'iMessage;-;chat1');
    expect(del).toHaveBeenCalledWith('/chat/iMessage%3B-%3Bchat1/icon', expect.anything());
  });
});
