/**
 * Camera photo recovery (src/ui/conversations/pendingCameraCapture.ts via Composer): Android can
 * kill Gator while the system camera is in front. expo-image-picker then keeps the photo for
 * `getPendingResultAsync()`. The tray records which chat opened the camera; this suite locks in:
 *   - the chat that opened the camera gets the recovered photo staged in its composer, and the
 *     record is cleared;
 *   - another chat leaves the photo (and the record) alone for the right chat;
 *   - after an account change (no record in the new account's database) the photo is discarded;
 *   - a lease that ends while the record is read stages nothing.
 *
 * In-file mocks: the camera-owner record service (an in-memory value), expo-image-picker, and the
 * account lease. The tray component is replaced by nothing (its own suite covers it) while its real
 * `pendingFromCameraAsset` helper still converts the asset.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';

let mockLeaseCurrent = true;
let mockRecord: string | null = null;
const mockSaveRecord = jest.fn(async (chatGuid: string) => {
  mockRecord = chatGuid || null;
});
const mockLoadRecord = jest.fn(async () => mockRecord);

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  // Jest requires these imports inside the hoisted mock factory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

jest.mock('expo-image', () => {
  // Jest requires these imports inside the hoisted mock factory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => React.createElement(View, props) };
});

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => ({ generation: 1, isCurrent: () => mockLeaseCurrent }),
  subscribeRealtimeGenerationInvalidation: () => () => undefined,
}));

jest.mock('@/services/cameraCapture', () => ({
  saveCameraCaptureChat: (chatGuid: string) => mockSaveRecord(chatGuid),
  loadCameraCaptureChat: () => mockLoadRecord(),
}));

jest.mock('expo-image-picker', () => ({
  getPendingResultAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));
jest.mock('expo-media-library/legacy', () => ({}));
jest.mock('expo-file-system/legacy', () => ({ getInfoAsync: jest.fn() }));

jest.mock('@ui/conversations/AttachmentTray', () => ({
  ...jest.requireActual('@ui/conversations/AttachmentTray'),
  AttachmentTray: () => null,
}));

// eslint-disable-next-line import/first
import * as ImagePicker from 'expo-image-picker';
// eslint-disable-next-line import/first
import { Composer } from '@ui/conversations/Composer';

const getPending = ImagePicker.getPendingResultAsync as unknown as jest.Mock;

const PHOTO = {
  uri: 'file:///cache/ImagePicker/recovered.jpg',
  fileName: 'recovered.jpg',
  mimeType: 'image/jpeg',
  fileSize: 1234,
  width: 400,
  height: 300,
  type: 'image',
};

beforeEach(() => {
  mockLeaseCurrent = true;
  mockRecord = null;
  mockSaveRecord.mockClear();
  mockLoadRecord.mockClear();
  getPending.mockReset();
  getPending.mockResolvedValue({ canceled: false, assets: [PHOTO] });
});

async function renderChat(chatGuid: string, onSendAttachments = jest.fn()): Promise<jest.Mock> {
  await renderWithTheme(
    <Composer onSend={jest.fn()} onSendAttachments={onSendAttachments} cameraChatGuid={chatGuid} />,
  );
  return onSendAttachments;
}

describe('Composer — recovering a camera photo after Android killed Gator', () => {
  it('stages the photo in the composer of the chat that opened the camera', async () => {
    mockRecord = 'chat-A';
    const onSendAttachments = await renderChat('chat-A');

    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
    expect(getPending).toHaveBeenCalledTimes(1);
    // The record is cleared so a later open can't stage it twice.
    await waitFor(() => expect(mockSaveRecord).toHaveBeenCalledWith(''));
    expect(mockRecord).toBeNull();

    await fireEvent.press(screen.getByLabelText('Send message'));
    expect(onSendAttachments).toHaveBeenCalledWith([
      {
        uri: PHOTO.uri,
        name: 'recovered.jpg',
        mimeType: 'image/jpeg',
        size: 1234,
        width: 400,
        height: 300,
      },
    ]);
  });

  it('leaves another chat’s photo waiting for that chat', async () => {
    mockRecord = 'chat-A';
    await renderChat('chat-B');

    await waitFor(() => expect(mockLoadRecord).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('Remove attachment')).toBeNull());
    expect(getPending).not.toHaveBeenCalled();
    expect(mockSaveRecord).not.toHaveBeenCalled();
    expect(mockRecord).toBe('chat-A');
  });

  it('discards the photo after an account change (the new account has no record)', async () => {
    // Disconnect wiped the old account's database, record included; the native result survives.
    mockRecord = null;
    await renderChat('chat-A');

    // It is drained so it can never surface later, but nothing is staged.
    await waitFor(() => expect(getPending).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
    expect(mockSaveRecord).not.toHaveBeenCalled();
  });

  it('stages nothing when the account lease ends while the record is read', async () => {
    mockRecord = 'chat-A';
    mockLoadRecord.mockImplementationOnce(async () => {
      mockLeaseCurrent = false;
      return 'chat-A';
    });
    await renderChat('chat-A');

    await waitFor(() => expect(mockLoadRecord).toHaveBeenCalled());
    expect(getPending).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
  });
});
