import type { MessageRow } from '@db/repositories';
import { statusFor } from '@utils';

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
});
