import React from 'react';
import { act, renderWithTheme, waitFor } from '../support/renderWithTheme';

jest.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  requestRecordingPermissionsAsync: jest.fn(),
  setAudioModeAsync: jest.fn(),
  useAudioRecorder: jest.fn(),
}));

// eslint-disable-next-line import/first
import { VoiceRecorder } from '@ui/conversations/VoiceRecorder';
// eslint-disable-next-line import/first
import * as Audio from 'expo-audio';

const mockRequestRecordingPermissionsAsync = Audio.requestRecordingPermissionsAsync as jest.Mock;
const mockUseAudioRecorder = Audio.useAudioRecorder as jest.Mock;

describe('VoiceRecorder permissions', () => {
  it('reports a denied microphone grant before closing', async () => {
    mockRequestRecordingPermissionsAsync.mockResolvedValueOnce({ granted: false });
    const prepareToRecordAsync = jest.fn();
    const record = jest.fn();
    mockUseAudioRecorder.mockReturnValueOnce({
      prepareToRecordAsync,
      record,
      stop: jest.fn(),
      uri: 'file://voice.m4a',
    });
    const onPermissionDenied = jest.fn();
    const onClose = jest.fn();

    await renderWithTheme(
      <VoiceRecorder
        onClose={onClose}
        onSend={jest.fn()}
        onPermissionDenied={onPermissionDenied}
      />,
    );

    await waitFor(() => expect(onPermissionDenied).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(prepareToRecordAsync).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('reports a native permission-request failure before closing', async () => {
    mockRequestRecordingPermissionsAsync.mockRejectedValueOnce(
      new Error('native permission failure'),
    );
    const prepareToRecordAsync = jest.fn();
    const record = jest.fn();
    mockUseAudioRecorder.mockReturnValueOnce({
      prepareToRecordAsync,
      record,
      stop: jest.fn(),
      uri: 'file://voice.m4a',
    });
    const onPermissionDenied = jest.fn();
    const onPermissionError = jest.fn();
    const onClose = jest.fn();

    await renderWithTheme(
      <VoiceRecorder
        onClose={onClose}
        onSend={jest.fn()}
        onPermissionDenied={onPermissionDenied}
        onPermissionError={onPermissionError}
      />,
    );

    await waitFor(() => expect(onPermissionError).toHaveBeenCalledTimes(1));
    expect(onPermissionDenied).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(prepareToRecordAsync).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('ignores a permission result that arrives after the recorder unmounts', async () => {
    let resolvePermission!: (value: { granted: boolean }) => void;
    mockRequestRecordingPermissionsAsync.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePermission = resolve)),
    );
    const prepareToRecordAsync = jest.fn();
    const record = jest.fn();
    mockUseAudioRecorder.mockReturnValueOnce({
      prepareToRecordAsync,
      record,
      stop: jest.fn(),
      uri: 'file://voice.m4a',
    });
    const onPermissionDenied = jest.fn();
    const onClose = jest.fn();

    const view = await renderWithTheme(
      <VoiceRecorder
        onClose={onClose}
        onSend={jest.fn()}
        onPermissionDenied={onPermissionDenied}
      />,
    );
    await view.unmount();

    await act(async () => {
      resolvePermission({ granted: false });
      await Promise.resolve();
    });

    expect(onPermissionDenied).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(prepareToRecordAsync).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
