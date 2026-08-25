import {
  claimActiveChat,
  isActiveChat,
  resetActiveChat,
} from '@/services/notifications/activeChat';

beforeEach(resetActiveChat);
afterEach(resetActiveChat);

describe('active chat visibility', () => {
  it('defaults to not visible for a headless process', () => {
    expect(isActiveChat('chat-a')).toBe(false);
  });

  it('matches only the exact chat after its route publishes real visibility', () => {
    const claim = claimActiveChat('chat-a');

    expect(isActiveChat('chat-a')).toBe(false);
    claim.setVisible(true);
    expect(isActiveChat('chat-a')).toBe(true);
    expect(isActiveChat('chat-b')).toBe(false);
    claim.setVisible(false);
    expect(isActiveChat('chat-a')).toBe(false);
  });

  it('does not let a stale blur or AppState callback clear or republish a newer chat', () => {
    const oldClaim = claimActiveChat('chat-a');
    oldClaim.setVisible(true);
    const currentClaim = claimActiveChat('chat-b');
    currentClaim.setVisible(true);

    oldClaim.release();
    oldClaim.setVisible(true);

    expect(isActiveChat('chat-a')).toBe(false);
    expect(isActiveChat('chat-b')).toBe(true);
  });

  it('invalidates retained claims on account reset', () => {
    const claim = claimActiveChat('same-guid');
    claim.setVisible(true);
    resetActiveChat();
    claim.setVisible(true);

    expect(isActiveChat('same-guid')).toBe(false);
  });
});
