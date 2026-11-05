import {
  DIRECT_MESSAGE_UNAVAILABLE,
  directMessageServiceFor,
  planDirectMessage,
} from '@/features/conversations/directMessagePlan';

describe('directMessageServiceFor', () => {
  it('pre-picks only a service Gator can start a chat on', () => {
    expect(directMessageServiceFor('iMessage')).toBe('iMessage');
    expect(directMessageServiceFor('RCS')).toBe('RCS');
    expect(directMessageServiceFor('SMS')).toBeNull();
    expect(directMessageServiceFor(null)).toBeNull();
  });
});

describe('planDirectMessage', () => {
  it('opens an existing one-to-one chat, encoding its id into the route', () => {
    expect(
      planDirectMessage({
        address: '+15551112222',
        service: 'iMessage',
        existingChatGuid: 'iMessage;-;+15551112222',
        newChatAvailable: false,
      }),
    ).toEqual({ kind: 'open', path: '/chat/iMessage%3B-%3B%2B15551112222' });
  });

  it('otherwise opens the new-message screen with the sender and the group’s service', () => {
    expect(
      planDirectMessage({
        address: 'laura@example.com',
        service: 'iMessage',
        existingChatGuid: null,
        newChatAvailable: true,
      }),
    ).toEqual({ kind: 'compose', params: { to: 'laura@example.com', service: 'iMessage' } });
    expect(
      planDirectMessage({
        address: '+15551112222',
        service: null,
        existingChatGuid: null,
        newChatAvailable: true,
      }),
    ).toEqual({ kind: 'compose', params: { to: '+15551112222' } });
  });

  it('explains when there is no chat and no way to start one', () => {
    expect(
      planDirectMessage({
        address: '+15551112222',
        service: 'RCS',
        existingChatGuid: null,
        newChatAvailable: false,
      }),
    ).toEqual({ kind: 'notice', message: DIRECT_MESSAGE_UNAVAILABLE });
  });
});
