import React from 'react';
import { Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockCreateAppleFaceTimeLink = jest.fn();
const mockStartAppleFaceTimeCall = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => undefined) }));
jest.mock('@/services', () => ({
  createAppleFaceTimeLink: (...args: unknown[]) => mockCreateAppleFaceTimeLink(...args),
  startAppleFaceTimeCall: (...args: unknown[]) => mockStartAppleFaceTimeCall(...args),
}));

// eslint-disable-next-line import/first
import FaceTimeScreen from '../../../app/(app)/facetime';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

const FACE_TIME_LINK = `https://facetime.apple.com/join#v=1&p=${'A'.repeat(22)}&k=${'A'.repeat(43)}`;
const mockClipboard = Clipboard.setStringAsync as jest.Mock;

function setCapabilities(linkEnabled: boolean, callEnabled = false): void {
  useSessionStore.setState({
    status: 'connected',
    origin: 'https://facetime-screen.test',
    password: 'test-only',
    serverInfo: {
      version: 'test',
      supports_facetime_link_creation: linkEnabled,
      supports_facetime_call_start: callEnabled,
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setCapabilities(false);
});

afterEach(() => jest.restoreAllMocks());

it('hides both mutations without either narrow capability', async () => {
  await renderWithTheme(<FaceTimeScreen />);

  expect(
    screen.getByText(/calling, answering, leaving calls, and call events are unavailable/i),
  ).toBeTruthy();
  expect(screen.getByText(/server does not support FaceTime link creation/i)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create FaceTime Link' })).toBeNull();
  expect(screen.queryByLabelText('FaceTime call address')).toBeNull();
});

it('creates once, then exposes the in-memory bearer link through Copy and native Share', async () => {
  setCapabilities(true);
  mockCreateAppleFaceTimeLink.mockResolvedValue({ status: 'accepted', link: FACE_TIME_LINK });
  const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  await renderWithTheme(<FaceTimeScreen />);

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Create FaceTime Link' }));
  });
  expect(mockCreateAppleFaceTimeLink).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Created FaceTime link').props.children).toBe(FACE_TIME_LINK);

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Copy' }));
  });
  expect(mockClipboard).toHaveBeenCalledWith(FACE_TIME_LINK);
  expect(screen.getByText('Link copied.')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Share' }));
  });
  expect(share).toHaveBeenCalledWith({ message: FACE_TIME_LINK });
});

it('shows conservative uncertainty and never fabricates a retry or link', async () => {
  setCapabilities(true);
  mockCreateAppleFaceTimeLink.mockResolvedValue({ status: 'outcome-unknown' });
  await renderWithTheme(<FaceTimeScreen />);

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Create FaceTime Link' }));
  });
  await waitFor(() =>
    expect(screen.getByText(/Check FaceTime before creating another/)).toBeTruthy(),
  );
  expect(mockCreateAppleFaceTimeLink).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Created FaceTime link')).toBeNull();
});

it('clears the bearer link immediately when its session owner changes', async () => {
  setCapabilities(true);
  mockCreateAppleFaceTimeLink.mockResolvedValue({ status: 'accepted', link: FACE_TIME_LINK });
  await renderWithTheme(<FaceTimeScreen />);
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Create FaceTime Link' }));
  });
  expect(screen.getByLabelText('Created FaceTime link')).toBeTruthy();

  await act(async () => {
    useSessionStore.setState((state) => ({
      epoch: state.epoch + 1,
      transportRevision: state.transportRevision + 1,
      sendCapabilityRevision: state.sendCapabilityRevision + 1,
      serverInfo: {
        version: 'replacement',
        supports_facetime_link_creation: false,
        supports_facetime_call_start: false,
      },
    }));
  });
  expect(screen.queryByLabelText('Created FaceTime link')).toBeNull();
});

it('shows call controls only for call capability and submits exact audio/video choices', async () => {
  setCapabilities(false, true);
  mockStartAppleFaceTimeCall.mockResolvedValue({ status: 'accepted' });
  await renderWithTheme(<FaceTimeScreen />);

  expect(screen.queryByRole('button', { name: 'Create FaceTime Link' })).toBeNull();
  const input = screen.getByLabelText('FaceTime call address');
  expect(input.props.value).toBe('');
  await act(async () => {
    fireEvent.changeText(input, 'alice@example.com');
  });

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Audio Call' }));
  });
  expect(mockStartAppleFaceTimeCall).toHaveBeenNthCalledWith(1, {
    address: 'alice@example.com',
    video: false,
  });
  expect(screen.getByText('FaceTime call started.')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Video Call' }));
  });
  expect(mockStartAppleFaceTimeCall).toHaveBeenNthCalledWith(2, {
    address: 'alice@example.com',
    video: true,
  });
});

it('keeps invalid spelling local and gives outcome-unknown copy that points to FaceTime', async () => {
  setCapabilities(false, true);
  mockStartAppleFaceTimeCall.mockResolvedValue({ status: 'outcome-unknown' });
  await renderWithTheme(<FaceTimeScreen />);
  const input = screen.getByLabelText('FaceTime call address');

  await act(async () => {
    fireEvent.changeText(input, 'Alice@example.com');
    fireEvent.press(screen.getByRole('button', { name: 'Video Call' }));
  });
  expect(mockStartAppleFaceTimeCall).not.toHaveBeenCalled();
  expect(input.props.value).toBe('Alice@example.com');

  await act(async () => {
    fireEvent.changeText(input, '+15551234567');
  });
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Video Call' }));
  });
  expect(mockStartAppleFaceTimeCall).toHaveBeenCalledWith({
    address: '+15551234567',
    video: true,
  });
  expect(screen.getByText(/Check FaceTime before trying again/)).toBeTruthy();
  expect(screen.getByLabelText('FaceTime call address').props.value).toBe('+15551234567');
});

it('discards the in-memory call address when its session owner changes', async () => {
  setCapabilities(false, true);
  await renderWithTheme(<FaceTimeScreen />);
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('FaceTime call address'), 'alice@example.com');
  });
  expect(screen.getByLabelText('FaceTime call address').props.value).toBe('alice@example.com');

  await act(async () => {
    useSessionStore.setState((state) => ({
      epoch: state.epoch + 1,
      transportRevision: state.transportRevision + 1,
      serverInfo: {
        version: 'replacement',
        supports_facetime_link_creation: false,
        supports_facetime_call_start: true,
      },
    }));
  });
  expect(screen.getByLabelText('FaceTime call address').props.value).toBe('');
});
