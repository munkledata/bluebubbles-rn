/**
 * Unit tests for the one-slot pending-notification stash
 * (`src/services/notifications/pendingNav.ts`).
 *
 * This is the deterministic backstop for the "tapping a notification while the app is
 * alive-but-backgrounded doesn't open the thread" fix: the headless onBackgroundEvent handler
 * stashes the tapped chat here, and the connected layout drains it on the next AppState 'active'.
 */
import {
  stashPendingNotification,
  takePendingNotification,
} from '@/services/notifications/pendingNav';

describe('pendingNav', () => {
  // The module holds a single slot of process-global state; empty it before each test so one
  // test's stash can't leak into the next.
  beforeEach(() => {
    takePendingNotification();
  });

  it('returns null when nothing has been stashed', () => {
    expect(takePendingNotification()).toBeNull();
  });

  it('stashes a tap and returns it once, then clears the slot', () => {
    stashPendingNotification({ chatGuid: 'c1', messageGuid: 'm1' });
    expect(takePendingNotification()).toEqual({ chatGuid: 'c1', messageGuid: 'm1' });
    // A second drain must be empty — a stale tap can't re-fire on a later resume.
    expect(takePendingNotification()).toBeNull();
  });

  it('keeps only the most recent tap (a newer notification supersedes an un-drained one)', () => {
    stashPendingNotification({ chatGuid: 'old' });
    stashPendingNotification({ chatGuid: 'new' });
    expect(takePendingNotification()).toEqual({ chatGuid: 'new' });
  });

  it('ignores an undefined data bag (a content-less press stashes nothing)', () => {
    stashPendingNotification(undefined);
    expect(takePendingNotification()).toBeNull();
  });
});
