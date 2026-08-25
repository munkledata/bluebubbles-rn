import { logger } from '@core/secure';
import type { AppDatabase } from '@db/types';
import {
  cancelSendFailureNotification,
  postSendFailureNotification,
} from '@/services/notifications/notifeeService';
import { clearFailedSendNotice, notifyFailedSend } from '@/services/send/sendFailureNotice';

jest.mock('@/services/notifications/notifeeService', () => ({
  cancelSendFailureNotification: jest.fn(async () => undefined),
  postSendFailureNotification: jest.fn(async () => undefined),
}));

const mockCancel = cancelSendFailureNotification as jest.Mock;
const mockPost = postSendFailureNotification as jest.Mock;
const db = {} as AppDatabase;

beforeEach(() => {
  mockCancel.mockReset().mockResolvedValue(undefined);
  mockPost.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sendFailureNotice', () => {
  it('posts only while the account guard is current and forwards no error prose', async () => {
    const guard = jest.fn(() => true);

    await notifyFailedSend(db, 'chat-guid', 'message-guid', guard);

    expect(mockPost).toHaveBeenCalledWith(db, 'chat-guid', 'message-guid', {
      generation: -1,
      isCurrent: guard,
    });
  });

  it('drops stale post and cancel work before touching the native layer', async () => {
    const stale = jest.fn(() => false);

    await notifyFailedSend(db, 'chat-guid', 'message-guid', stale);
    await clearFailedSendNotice(db, 'message-guid', stale);

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('contains native post failure and logs only a fixed event plus the error class', async () => {
    const canary = 'PRIVATE_SERVER_DETAIL_CANARY';
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockPost.mockRejectedValueOnce(new Error(canary));

    await expect(notifyFailedSend(db, 'chat-guid', 'message-guid')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[send] failed to post failure notice', {
      errorName: 'Error',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
  });

  it('contains native cancel failure without exposing its detail', async () => {
    const canary = 'PRIVATE_CANCEL_DETAIL_CANARY';
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockCancel.mockRejectedValueOnce(new TypeError(canary));

    await expect(clearFailedSendNotice(db, 'message-guid')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('[send] failed to clear failure notice', {
      errorName: 'TypeError',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
  });
});
