const mockGetInfoAsync = jest.fn();
const mockCreateUploadTask = jest.fn();
const mockUploadAsync = jest.fn();
const mockCancelAsync = jest.fn(async () => undefined);
const mockRemoveSubscription = jest.fn();

jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: mockGetInfoAsync,
  createUploadTask: mockCreateUploadTask,
  FileSystemUploadType: { MULTIPART: 1 },
}));

// Mocks must exist before the native transport module evaluates.
// eslint-disable-next-line import/first
import { HttpClient } from '@core/api/http';
// eslint-disable-next-line import/first
import { expoGroupPhotoUploader } from '@/services/groupPhotoUpload';

const CHAT_GUID = 'iMessage;+;chat123456789';

describe('native group photo upload transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 4_096 });
    mockUploadAsync.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        status: 200,
        message: 'Success',
        data: { updated: true, guid: CHAT_GUID, operation: 'set' },
      }),
    });
    mockCreateUploadTask.mockReturnValue({
      uploadAsync: mockUploadAsync,
      cancelAsync: mockCancelAsync,
      removeSubscription: mockRemoveSubscription,
    });
  });

  it('uses one legacy streaming task with the exact pinned multipart contract', async () => {
    const http = new HttpClient({
      getOrigin: () => 'https://photo.example',
      getPassword: () => 'photo-password',
      getCustomHeaders: () => ({ 'x-custom': 'exact' }),
    }).pinTransport();
    const onDispatch = jest.fn();
    const assertNetworkStart = jest.fn();

    await expect(
      expoGroupPhotoUploader({
        http,
        chatGuid: CHAT_GUID,
        tempGuid: 'temp-photo1',
        image: {
          uri: 'file:///picker/group-photo.jpg',
          name: 'group-photo.jpg',
          mimeType: 'image/jpeg',
          size: 4_096,
        },
        signal: new AbortController().signal,
        assertNetworkStart,
        onDispatch,
      }),
    ).resolves.toEqual({ updated: true, guid: CHAT_GUID, operation: 'set' });

    expect(mockCreateUploadTask).toHaveBeenCalledTimes(1);
    expect(mockCreateUploadTask).toHaveBeenCalledWith(
      'https://photo.example/api/v1/chat/iMessage%3B%2B%3Bchat123456789/icon',
      'file:///picker/group-photo.jpg',
      {
        httpMethod: 'POST',
        uploadType: 1,
        fieldName: 'icon',
        mimeType: 'image/jpeg',
        parameters: { tempGuid: 'temp-photo1' },
        headers: expect.objectContaining({
          Authorization: 'Bearer photo-password',
          'x-custom': 'exact',
        }),
      },
    );
    expect(assertNetworkStart).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(mockUploadAsync).toHaveBeenCalledTimes(1);
    expect(mockRemoveSubscription).toHaveBeenCalledTimes(1);
  });
});
