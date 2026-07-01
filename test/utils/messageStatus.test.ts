import type { MessageRow } from '@db/repositories';
import { deliveredQuietly, errorTitleForCode, sendErrorCode, statusFor } from '@utils';
import { ClientErrorCode } from '@utils/messageStatus';

function m(p: Partial<MessageRow>): MessageRow {
  return {
    id: 0,
    guid: 'g',
    chatId: 1,
    handleId: null,
    text: '',
    attributedBody: null,
    subject: null,
    isFromMe: 1,
    dateCreated: 0,
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateRetracted: null,
    hasAttachments: 0,
    error: 0,
    sendState: 'sent',
    wasDeliveredQuietly: 0,
    didNotifyRecipient: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: null,
    senderName: null,
    senderAvatar: null,
    senderService: null,
    ...p,
  };
}

describe('statusFor', () => {
  it('returns null for received messages', () => {
    expect(statusFor(m({ isFromMe: 0 }))).toBeNull();
  });
  it('reflects the send lifecycle', () => {
    expect(statusFor(m({ sendState: 'sending' }))).toBe('Sending…');
    expect(statusFor(m({ sendState: 'error' }))).toBe('Not Delivered');
    expect(statusFor(m({ error: 401 }))).toBe('Not Delivered');
    expect(statusFor(m({ dateDelivered: 1000 }))).toBe('Delivered');
    expect(statusFor(m({ dateRead: 1700000000000 }))).toMatch(/^Read /);
    expect(statusFor(m({}))).toBe('Sent');
  });

  it('surfaces the "Delivered Quietly" tier (2.2)', () => {
    // Quiet delivery: delivered without notifying the recipient.
    expect(
      statusFor(m({ dateDelivered: 1000, wasDeliveredQuietly: 1, didNotifyRecipient: 0 })),
    ).toBe('Delivered Quietly');
    // Quietly flag set but the recipient WAS notified → plain "Delivered".
    expect(
      statusFor(m({ dateDelivered: 1000, wasDeliveredQuietly: 1, didNotifyRecipient: 1 })),
    ).toBe('Delivered');
    // Not delivered quietly → plain "Delivered".
    expect(statusFor(m({ dateDelivered: 1000, wasDeliveredQuietly: 0 }))).toBe('Delivered');
    // A later "Read" supersedes the quiet-delivery tier.
    expect(
      statusFor(m({ dateRead: 1700000000000, wasDeliveredQuietly: 1, didNotifyRecipient: 0 })),
    ).toMatch(/^Read /);
  });
});

describe('deliveredQuietly (2.2)', () => {
  it('is true only when delivered quietly AND not notified', () => {
    expect(deliveredQuietly({ wasDeliveredQuietly: 1, didNotifyRecipient: 0 })).toBe(true);
    expect(deliveredQuietly({ wasDeliveredQuietly: 1, didNotifyRecipient: 1 })).toBe(false);
    expect(deliveredQuietly({ wasDeliveredQuietly: 0, didNotifyRecipient: 0 })).toBe(false);
  });
});

describe('errorTitleForCode (2.4)', () => {
  it('maps client error codes (≥10000) to friendly titles', () => {
    expect(errorTitleForCode(10001)).toBe('Client Error');
    expect(errorTitleForCode(10002)).toBe('Bad Gateway');
    expect(errorTitleForCode(10003)).toBe('Network Timed Out');
    expect(errorTitleForCode(10004)).toBe('Connection Refused');
    expect(errorTitleForCode(10005)).toBe('Not Found');
    expect(errorTitleForCode(10006)).toBe('Edit Failed');
    expect(errorTitleForCode(10007)).toBe('Unsend Failed');
    expect(errorTitleForCode(10008)).toBe('Manually Canceled');
  });

  it('falls back to "iMessage Error (Code N)" for positive server codes', () => {
    expect(errorTitleForCode(22)).toBe('iMessage Error (Code 22)');
    expect(errorTitleForCode(404)).toBe('iMessage Error (Code 404)');
  });

  it('uses the generic title for zero / negative / null codes', () => {
    expect(errorTitleForCode(0)).toBe('Message Failed to Send');
    expect(errorTitleForCode(-1)).toBe('Message Failed to Send');
    expect(errorTitleForCode(null)).toBe('Message Failed to Send');
    expect(errorTitleForCode(undefined)).toBe('Message Failed to Send');
  });
});

describe('sendErrorCode', () => {
  it('maps gateway / not-found statuses to their client codes', () => {
    expect(sendErrorCode(502)).toBe(ClientErrorCode.badGateway);
    expect(sendErrorCode(504)).toBe(ClientErrorCode.gatewayTimeout);
    expect(sendErrorCode(404)).toBe(ClientErrorCode.notFound);
  });

  it('keeps any other server status verbatim', () => {
    expect(sendErrorCode(500)).toBe(500);
    expect(sendErrorCode(422)).toBe(422);
  });

  it('treats a missing HTTP status (network failure) as connectionRefused', () => {
    // Previously collapsed to -1 ("Message Failed to Send"); now a specific title.
    expect(sendErrorCode(null)).toBe(ClientErrorCode.connectionRefused);
    expect(errorTitleForCode(sendErrorCode(null))).toBe('Connection Refused');
  });
});
