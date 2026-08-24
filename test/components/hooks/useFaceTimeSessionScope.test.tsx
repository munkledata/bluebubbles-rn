import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';
import { faceTimeApi } from '@core/api';
import { logger } from '@core/secure';
import { getChatParticipants } from '@db/repositories';
import { useFaceTime, type StartCallArgs } from '@features/facetime/useFaceTime';
import { useIncomingFaceTime } from '@features/facetime/useIncomingFaceTime';
import { resolveFaceTimeAnswerLink } from '@features/facetime/answerLink';
import { createNewChat } from '@/services';
import { send } from '@/services/send';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { useFaceTimeStore, type IncomingFaceTimeCall } from '@state/faceTimeStore';
import { showDialog } from '@ui/dialog/dialogStore';

const mockIsDevServer = jest.fn();

jest.mock('@utils/isDev', () => ({ isDevServer: () => mockIsDevServer() }));
jest.mock('@core/api', () => ({
  faceTimeApi: {
    createFaceTimeLink: jest.fn(),
    leaveFaceTime: jest.fn(),
  },
}));
jest.mock('@db/repositories', () => ({ getChatParticipants: jest.fn() }));
jest.mock('@/services', () => ({ http: {}, createNewChat: jest.fn() }));
jest.mock('@/services/send', () => ({ send: jest.fn() }));
jest.mock('@features/facetime/answerLink', () => ({ resolveFaceTimeAnswerLink: jest.fn() }));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

const mockCreateLink = faceTimeApi.createFaceTimeLink as jest.Mock;
const mockGetParticipants = getChatParticipants as jest.Mock;
const mockCreateNewChat = createNewChat as jest.Mock;
const mockSend = send as jest.Mock;
const mockResolveAnswerLink = resolveFaceTimeAnswerLink as jest.Mock;
const mockShowDialog = showDialog as jest.Mock;
const mockOpenBrowser = WebBrowser.openBrowserAsync as jest.Mock;

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  mockIsDevServer.mockReturnValue(false);
  mockGetParticipants.mockResolvedValue([{ address: '+15551234567' }]);
  mockCreateLink.mockResolvedValue('https://facetime.apple.com/join#new-call');
  mockCreateNewChat.mockResolvedValue(undefined);
  mockSend.mockResolvedValue(undefined);
  mockOpenBrowser.mockResolvedValue({ type: 'dismiss' });
  useFaceTimeStore.getState().reset();
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

it('does not let a retained account-A chat callback adopt account B', async () => {
  const { result } = await renderHook(() => useFaceTime());
  const oldStartCall = result.current.startCall;

  await act(async () => {
    await pauseRealtimeDeliveries();
    useFaceTimeStore.getState().reset();
    resumeRealtimeDeliveries();
    await oldStartCall({ chatGuid: 'account-a-chat', video: true });
  });

  expect(mockGetParticipants).not.toHaveBeenCalled();
  expect(mockCreateLink).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockOpenBrowser).not.toHaveBeenCalled();
  expect(mockShowDialog).not.toHaveBeenCalled();
});

it('does not let a retained account-A dialer callback adopt account B', async () => {
  const { result } = await renderHook(() => useFaceTime());
  const oldStartCallTo = result.current.startCallTo;

  await act(async () => {
    await pauseRealtimeDeliveries();
    useFaceTimeStore.getState().reset();
    resumeRealtimeDeliveries();
    await oldStartCallTo({ addresses: ['account-a@example.com'], video: false });
  });

  expect(mockCreateLink).not.toHaveBeenCalled();
  expect(mockCreateNewChat).not.toHaveBeenCalled();
  expect(mockOpenBrowser).not.toHaveBeenCalled();
  expect(mockShowDialog).not.toHaveBeenCalled();
});

it('does not launch a browser when logout occurs while the FaceTime link message is sending', async () => {
  let finishSend!: () => void;
  mockSend.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishSend = resolve;
    }),
  );
  const { result } = await renderHook(() => useFaceTime());
  let start!: Promise<void>;

  await act(async () => {
    const args: StartCallArgs = { chatGuid: 'old-chat', video: true };
    start = result.current.startCall(args);
    await Promise.resolve();
  });
  await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));

  await act(async () => {
    useFaceTimeStore.getState().reset();
  });
  await act(async () => {
    finishSend();
    await start;
  });

  expect(mockOpenBrowser).not.toHaveBeenCalled();
  expect(mockShowDialog).not.toHaveBeenCalled();
  expect(useFaceTimeStore.getState().call).toBeNull();
});

it('does not reopen an answered incoming call when its link resolves after logout', async () => {
  let finishAnswer!: (link: string) => void;
  mockResolveAnswerLink.mockReturnValueOnce(
    new Promise<string>((resolve) => {
      finishAnswer = resolve;
    }),
  );
  const incoming: IncomingFaceTimeCall = {
    uuid: 'old-call',
    callerName: 'Previous account caller',
    isAudio: false,
  };
  useFaceTimeStore.getState().ring(incoming);
  const { result } = await renderHook(() => useIncomingFaceTime());
  let answer!: Promise<void>;

  await act(async () => {
    answer = result.current.answer(incoming);
    await Promise.resolve();
  });
  expect(useFaceTimeStore.getState().incoming).toBeNull();
  await act(async () => {
    useFaceTimeStore.getState().reset();
  });

  await act(async () => {
    finishAnswer('https://facetime.apple.com/join#old-call');
    await answer;
  });

  expect(useFaceTimeStore.getState()).toMatchObject({ call: null, incoming: null });
  expect(mockShowDialog).not.toHaveBeenCalled();
});

it('does not let an old dialer completion create B-account work or open a browser after reconnect', async () => {
  let finishCreate!: () => void;
  mockCreateNewChat.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finishCreate = resolve;
    }),
  );
  const { result } = await renderHook(() => useFaceTime());
  let start!: Promise<void>;

  await act(async () => {
    start = result.current.startCallTo({ addresses: ['old@example.com'], video: true });
    await Promise.resolve();
  });
  await waitFor(() => expect(mockCreateNewChat).toHaveBeenCalledTimes(1));
  const accountLease = mockCreateNewChat.mock.calls[0]?.[3] as { isCurrent: () => boolean };
  expect(accountLease.isCurrent()).toBe(true);

  await act(async () => {
    await pauseRealtimeDeliveries();
    useFaceTimeStore.getState().reset();
    resumeRealtimeDeliveries();
  });
  await act(async () => {
    finishCreate();
    await start;
  });

  expect(mockCreateLink).toHaveBeenCalledTimes(1);
  expect(mockCreateNewChat).toHaveBeenCalledTimes(1);
  expect(mockOpenBrowser).not.toHaveBeenCalled();
  expect(mockShowDialog).not.toHaveBeenCalled();
  expect(useFaceTimeStore.getState()).toMatchObject({ call: null, incoming: null });
  expect(accountLease.isCurrent()).toBe(false);
});

it('does not fall through to another browser after logout while Chrome is rejecting', async () => {
  let rejectChrome!: (error: Error) => void;
  mockOpenBrowser.mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectChrome = reject;
    }),
  );
  const defaultBrowser = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true);
  const { result } = await renderHook(() => useFaceTime());
  let start!: Promise<void>;

  await act(async () => {
    start = result.current.startCallTo({ addresses: ['old@example.com'], video: false });
    await Promise.resolve();
  });
  await waitFor(() => expect(mockOpenBrowser).toHaveBeenCalledTimes(1));

  await act(async () => {
    await pauseRealtimeDeliveries();
    useFaceTimeStore.getState().reset();
    resumeRealtimeDeliveries();
    rejectChrome(new Error('Chrome unavailable'));
    await start;
  });

  expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
  expect(defaultBrowser).not.toHaveBeenCalled();
  expect(mockShowDialog).not.toHaveBeenCalled();
  defaultBrowser.mockRestore();
});

it('does not reach Linking after logout while the default custom tab is rejecting', async () => {
  const warning = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  mockOpenBrowser.mockRejectedValueOnce(new Error('Chrome unavailable'));
  let rejectCustomTab!: (error: Error) => void;
  mockOpenBrowser.mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectCustomTab = reject;
    }),
  );
  const systemBrowser = jest.spyOn(Linking, 'openURL').mockResolvedValueOnce(true);
  const { result } = await renderHook(() => useFaceTime());
  let start!: Promise<void>;

  await act(async () => {
    start = result.current.startCallTo({ addresses: ['old@example.com'], video: false });
    await Promise.resolve();
  });
  await waitFor(() => expect(mockOpenBrowser).toHaveBeenCalledTimes(2));

  await act(async () => {
    await pauseRealtimeDeliveries();
    useFaceTimeStore.getState().reset();
    resumeRealtimeDeliveries();
    rejectCustomTab(new Error('custom tab unavailable'));
    await start;
  });

  expect(mockOpenBrowser).toHaveBeenCalledTimes(2);
  expect(systemBrowser).not.toHaveBeenCalled();
  expect(mockShowDialog).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalledTimes(1);
  systemBrowser.mockRestore();
  warning.mockRestore();
});
