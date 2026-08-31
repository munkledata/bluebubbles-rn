import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

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
const mockSetAudioModeAsync = Audio.setAudioModeAsync as jest.Mock;
const mockUseAudioRecorder = Audio.useAudioRecorder as jest.Mock;

beforeEach(() => {
  mockRequestRecordingPermissionsAsync.mockReset();
  mockSetAudioModeAsync.mockReset().mockResolvedValue(undefined);
  mockUseAudioRecorder.mockReset();
});

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

  it('asks before hardware Back discards an active recording', async () => {
    mockRequestRecordingPermissionsAsync.mockResolvedValueOnce({ granted: true });
    const stop = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn();
    mockUseAudioRecorder.mockReturnValue({
      prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
      record,
      stop,
      uri: 'file://voice.m4a',
    });
    const onClose = jest.fn();

    await renderWithTheme(<VoiceRecorder onClose={onClose} onSend={jest.fn()} />);
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));

    const modal = screen.root;
    expect(modal?.type).toBe('Modal');
    await act(async () => {
      fireEvent(modal!, 'requestClose');
    });
    expect(screen.getByText('Discard this recording?')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByText('Keep Recording'));
    });
    expect(screen.queryByText('Discard this recording?')).toBeNull();
    expect(screen.getByText('Send')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent(screen.root!, 'requestClose');
    });
    expect(screen.getByText('Discard this recording?')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByText('Discard'));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(stop).toHaveBeenCalledTimes(1);
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

  it('stops an active recording and sends its URI exactly once', async () => {
    mockRequestRecordingPermissionsAsync.mockResolvedValueOnce({ granted: true });
    const stop = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn();
    const prepareToRecordAsync = jest.fn().mockResolvedValue(undefined);
    mockUseAudioRecorder.mockReturnValueOnce({
      prepareToRecordAsync,
      record,
      stop,
      uri: 'file://voice.m4a',
    });
    const onSend = jest.fn();
    const onClose = jest.fn();

    await renderWithTheme(<VoiceRecorder onClose={onClose} onSend={onSend} />);
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.press(screen.getByText('Send'));
    });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('file://voice.m4a'));

    expect(mockSetAudioModeAsync).toHaveBeenCalledWith({
      allowsRecording: true,
      playsInSilentMode: true,
    });
    expect(prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.press(screen.getByText('Send'));
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
