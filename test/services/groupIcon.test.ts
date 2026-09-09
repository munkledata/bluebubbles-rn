// The module imports expo-file-system/legacy (native) for the upload path; stub it so the
// http-only removeGroupIcon can be tested in the node project.
jest.mock('expo-file-system/legacy', () => ({
  uploadAsync: jest.fn(),
  FileSystemUploadType: { MULTIPART: 1 },
}));

// eslint-disable-next-line import/first
import { removeGroupIcon, uploadGroupIcon } from '@/services/chat/groupIcon';
// eslint-disable-next-line import/first
import type { HttpClient } from '@core/api/http';

describe('groupIcon', () => {
  it('uploads with one captured native URL/header identity', async () => {
    const uploadAsync = jest.requireMock('expo-file-system/legacy').uploadAsync as jest.Mock;
    uploadAsync.mockResolvedValue({ status: 200, body: '' });
    const http = {
      snapshotTransport: () => ({
        headers: { Authorization: 'Bearer old-password' },
        buildUrl: (path: string) => `https://old.example/api/v1${path}`,
      }),
    } as unknown as HttpClient;

    await uploadGroupIcon(http, 'iMessage;-;chat1', {
      uri: 'file:///icon.jpg',
      name: 'icon.jpg',
      mimeType: 'image/jpeg',
    });

    expect(uploadAsync).toHaveBeenCalledWith(
      'https://old.example/api/v1/chat/iMessage%3B-%3Bchat1/icon',
      'file:///icon.jpg',
      expect.objectContaining({ headers: { Authorization: 'Bearer old-password' } }),
    );
  });

  it.each([301, 302, 303, 307, 308])('rejects redirect status %i', async (status) => {
    const uploadAsync = jest.requireMock('expo-file-system/legacy').uploadAsync as jest.Mock;
    uploadAsync.mockResolvedValueOnce({ status, body: '' });
    const http = {
      snapshotTransport: () => ({
        headers: { Authorization: 'Bearer old-password' },
        buildUrl: (path: string) => `https://old.example/api/v1${path}`,
      }),
    } as unknown as HttpClient;

    await expect(
      uploadGroupIcon(http, 'iMessage;-;chat1', {
        uri: 'file:///icon.jpg',
        name: 'icon.jpg',
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ kind: 'server_error', status });
  });

  it('removeGroupIcon DELETEs /chat/:guid/icon (guid encoded)', async () => {
    const del = jest.fn(() => Promise.resolve({}));
    const http = { delete: del } as unknown as HttpClient;
    await removeGroupIcon(http, 'iMessage;-;chat1');
    expect(del).toHaveBeenCalledWith('/chat/iMessage%3B-%3Bchat1/icon', expect.anything());
  });
});
