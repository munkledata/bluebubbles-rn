/**
 * `syncContacts` must share ONE in-flight run across concurrent callers.
 *
 * `upsertContacts` writes a whole new generation before pruning the old one, so two overlapping
 * runs prune each other's rows — and the match pass then unlinks and renames every handle the
 * other run hasn't written yet, i.e. the inbox flips to raw phone numbers. Both callers (the sync
 * pipeline and the Settings button) fire uncoordinated.
 *
 * Three things the coalescing must NOT cost, all covered below: a `force: true` caller (the manual
 * Settings button) still gets a fresh address-book read rather than the answer of a run that
 * started before the user's edit; a run that never settles releases the slot instead of wedging
 * contacts sync for the rest of the process; and a caller CHAINED onto such a run inherits that
 * cap rather than the wedge.
 *
 * expo-contacts, the DB handle, the repositories and the HTTP client are all mocked: only the
 * coalescing wrapper is under test here.
 */
const requestPermissionsAsync = jest.fn();
const getPermissionsAsync = jest.fn();
const getContactsAsync = jest.fn();
const presentContactPickerAsync = jest.fn();
const matchContactsToHandles = jest.fn();
const upsertContacts = jest.fn();
const refreshShareShortcuts = jest.fn();

jest.mock('expo-contacts/legacy', () => ({
  requestPermissionsAsync,
  getPermissionsAsync,
  getContactsAsync,
  presentContactPickerAsync,
  Fields: {
    Name: 'name',
    FirstName: 'firstName',
    LastName: 'lastName',
    PhoneNumbers: 'phoneNumbers',
    Emails: 'emails',
    Image: 'image',
  },
}));
jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@db/repositories', () => ({ upsertContacts, matchContactsToHandles }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@/services/contacts/serverAvatars', () => ({
  backfillServerAvatars: jest.fn(async () => 0),
}));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({ refreshShareShortcuts }));

// eslint-disable-next-line import/first
import {
  ContactsPermissionDeniedError,
  isContactsAccountChangedError,
  isContactsPermissionDeniedError,
  pickContact,
  syncContacts,
} from '@/services/contacts/contactsService';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

// jest's clearMocks wipes call history but not implementations — re-arm both every test.
beforeEach(() => {
  requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
  getPermissionsAsync.mockResolvedValue({ status: 'granted' });
  upsertContacts.mockResolvedValue(0);
  matchContactsToHandles.mockResolvedValue(0);
});

describe('pickContact permission outcome', () => {
  it('distinguishes permission denial from a canceled picker', async () => {
    requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });

    const denied = pickContact();
    await expect(denied).rejects.toBeInstanceOf(ContactsPermissionDeniedError);
    await denied.catch((error) => {
      expect(isContactsPermissionDeniedError(error)).toBe(true);
      expect(error).toMatchObject({ canAskAgain: false });
    });
    expect(presentContactPickerAsync).not.toHaveBeenCalled();

    requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' });
    presentContactPickerAsync.mockResolvedValueOnce(null);
    await expect(pickContact()).resolves.toBeNull();
  });
});

describe('syncContacts coalescing', () => {
  it('checks an existing grant without prompting during automatic startup sync', async () => {
    getPermissionsAsync.mockResolvedValueOnce({ status: 'undetermined' });

    await expect(syncContacts()).rejects.toThrow('contacts-permission-denied');

    expect(getPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(requestPermissionsAsync).not.toHaveBeenCalled();
    expect(getContactsAsync).not.toHaveBeenCalled();
  });

  it('requests permission for the explicit forced Settings sync', async () => {
    getContactsAsync.mockResolvedValueOnce({ data: [] });

    await expect(syncContacts({ force: true })).resolves.toEqual({ contacts: 0, matched: 0 });

    expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(getPermissionsAsync).not.toHaveBeenCalled();
    expect(getContactsAsync).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight run, then allows a fresh one once it settles', async () => {
    let release!: () => void;
    getContactsAsync.mockImplementation(
      () => new Promise((r) => (release = () => r({ data: [] }))),
    );

    const a = syncContacts();
    const b = syncContacts();
    expect(a).toBe(b); // the same promise object → a single underlying run

    // Let the permission await settle so the device read has genuinely started.
    await Promise.resolve();
    await Promise.resolve();
    expect(getContactsAsync).toHaveBeenCalledTimes(1);

    const c = syncContacts(); // joining mid-flight still shares the run
    expect(c).toBe(a);

    release();
    expect(await a).toEqual({ contacts: 0, matched: 0 });
    await b;
    await c;
    expect(getContactsAsync).toHaveBeenCalledTimes(1);

    // The slot clears on settle, so a later sync is a real new run (not a stuck cached promise).
    getContactsAsync.mockResolvedValue({ data: [] });
    const d = syncContacts();
    expect(d).not.toBe(a);
    await d;
    expect(getContactsAsync).toHaveBeenCalledTimes(2);
  });

  it('clears the slot when a run rejects, so a failure never wedges contacts sync forever', async () => {
    getContactsAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(syncContacts()).rejects.toThrow('boom');
    getContactsAsync.mockResolvedValue({ data: [] });
    await expect(syncContacts()).resolves.toEqual({ contacts: 0, matched: 0 });
  });

  // The Settings button exists to re-read the address book NOW. Joining an in-flight run would
  // report counts from a device read that happened BEFORE the user added the contact they are
  // syncing for — success, with the new name still missing. So it CHAINS: serialized (the truncate
  // race is the whole point of the coalescing) but with its own fresh read at the end.
  it('a forced call chains a SECOND read behind the in-flight run instead of joining it', async () => {
    let releaseFirst!: () => void;
    getContactsAsync
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = () => r({ data: [] }))))
      .mockImplementationOnce(async () => ({ data: [] }));
    // Distinguishable results: the forced caller must get the SECOND run's counts.
    upsertContacts.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const auto = syncContacts(); // the sync pipeline's fire-and-forget run
    await Promise.resolve();
    await Promise.resolve();
    expect(getContactsAsync).toHaveBeenCalledTimes(1);

    const forced = syncContacts({ force: true }); // the user taps "Sync Contacts" mid-run
    expect(forced).not.toBe(auto);
    let forcedSettled = false;
    void forced.then(() => {
      forcedSettled = true;
    });

    // Serialized, not concurrent: the second read has not started while the first is still going.
    await Promise.resolve();
    await Promise.resolve();
    expect(getContactsAsync).toHaveBeenCalledTimes(1);
    expect(forcedSettled).toBe(false);

    releaseFirst();
    await expect(auto).resolves.toEqual({ contacts: 1, matched: 0 });
    await expect(forced).resolves.toEqual({ contacts: 2, matched: 0 }); // its own read, not the first's
    expect(getContactsAsync).toHaveBeenCalledTimes(2);
  });

  // A promise that never settles would otherwise be handed to every later caller forever (the
  // Android permission dialog the user escapes by backgrounding the app leaves exactly that), so
  // contacts would never sync again until the process restarted.
  it('abandons a run that never settles, so it cannot wedge sync for the process lifetime', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      getContactsAsync.mockImplementationOnce(() => new Promise<never>(() => {})); // never settles
      const stuck = syncContacts();
      await Promise.resolve();
      await Promise.resolve();
      expect(getContactsAsync).toHaveBeenCalledTimes(1);

      // Inside the window it is still treated as live — normal overlapping callers coalesce.
      now.mockReturnValue(61_000);
      expect(syncContacts()).toBe(stuck);
      expect(getContactsAsync).toHaveBeenCalledTimes(1);

      // Past it, the slot is abandoned and an ordinary (unforced) sync really runs again.
      now.mockReturnValue(121_000);
      getContactsAsync.mockResolvedValue({ data: [] });
      const fresh = syncContacts();
      expect(fresh).not.toBe(stuck);
      await expect(fresh).resolves.toEqual({ contacts: 0, matched: 0 });
      expect(getContactsAsync).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  // The abandonment check runs ONCE, at call time. A forced tap arriving just INSIDE the window
  // therefore still sees the wedged run as live and chains onto it — so the chain needs the cap
  // too, or the Settings spinner never clears for the life of that screen.
  it('a forced call chained onto a wedged run still completes (the chain inherits the cap)', async () => {
    jest.useFakeTimers();
    try {
      getContactsAsync
        .mockImplementationOnce(() => new Promise<never>(() => {})) // wedged for good
        .mockImplementation(async () => ({ data: [] }));
      upsertContacts.mockResolvedValue(7);

      syncContacts(); // boot's fire-and-forget run
      await Promise.resolve();
      await Promise.resolve();
      expect(getContactsAsync).toHaveBeenCalledTimes(1);

      const forced = syncContacts({ force: true }); // the user taps "Sync Contacts"
      await Promise.resolve();
      await Promise.resolve();
      expect(getContactsAsync).toHaveBeenCalledTimes(1); // still serialized behind the wedge

      // Once the predecessor's window elapses it is abandoned, and the chained run goes ahead.
      jest.advanceTimersByTime(120_000);
      await expect(forced).resolves.toEqual({ contacts: 7, matched: 0 });
      expect(getContactsAsync).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  // …and chaining must not RE-ARM that cap. The slot's age belongs to the run it is waiting on,
  // not to the moment a newer caller published itself, or every tap would postpone the deadline.
  it('a forced call does not restart the abandonment clock for later callers', async () => {
    const now = jest.spyOn(Date, 'now');
    let releaseStuck!: () => void;
    try {
      now.mockReturnValue(1_000);
      getContactsAsync.mockImplementationOnce(
        () => new Promise((r) => (releaseStuck = () => r({ data: [] }))),
      );
      const stuck = syncContacts();
      await Promise.resolve();
      await Promise.resolve();
      expect(getContactsAsync).toHaveBeenCalledTimes(1);

      // A forced tap 59s in chains onto the (apparently) live run.
      now.mockReturnValue(60_000);
      getContactsAsync.mockResolvedValue({ data: [] });
      const forced = syncContacts({ force: true });

      // 120s after the run STARTED it is abandoned — an ordinary caller must start its own run,
      // not join a chain the tap re-stamped as fresh.
      now.mockReturnValue(121_000);
      const later = syncContacts();
      expect(later).not.toBe(forced);
      await expect(later).resolves.toEqual({ contacts: 0, matched: 0 });
      expect(getContactsAsync).toHaveBeenCalledTimes(2);

      // Unwedge so the chained run drains and its abandonment timer is cleared.
      releaseStuck();
      await stuck;
      await forced;
    } finally {
      now.mockRestore();
    }
  });

  // Only the run that still OWNS the coalescing slot may clear it. A forced call publishes a NEW
  // slot over a run that is still going, so when that older run settles it must leave the slot
  // alone — clearing it lets the next caller start a THIRD read concurrently with the forced one,
  // which is the overlapping generation swap this whole module exists to prevent (see the header).
  // No other test settles the OLD run while a forced one owns the slot, so this ordering is the
  // only thing pinning the identity check.
  it('a caller arriving after the OLD run settles joins the forced run, not a third one', async () => {
    let releaseAuto!: () => void;
    getContactsAsync
      .mockImplementationOnce(() => new Promise((r) => (releaseAuto = () => r({ data: [] }))))
      .mockImplementation(async () => ({ data: [] }));

    const auto = syncContacts(); // the sync pipeline's fire-and-forget run
    await Promise.resolve();
    await Promise.resolve();
    expect(getContactsAsync).toHaveBeenCalledTimes(1);

    const forced = syncContacts({ force: true }); // takes the slot over, chained behind `auto`
    expect(forced).not.toBe(auto);

    releaseAuto(); // the OLDER run settles while the forced one owns the slot
    await auto;
    await Promise.resolve();
    await Promise.resolve();

    // Everything arriving now must JOIN the forced run rather than race a fresh read alongside it.
    expect(syncContacts()).toBe(forced);
    await forced;
    expect(getContactsAsync).toHaveBeenCalledTimes(2);
  });

  it("does not let account B join account A's delayed native contact read", async () => {
    let finishAccountA!: (value: { data: [] }) => void;
    getContactsAsync
      .mockImplementationOnce(
        () =>
          new Promise<{ data: [] }>((resolve) => {
            finishAccountA = resolve;
          }),
      )
      .mockResolvedValueOnce({ data: [] });

    const accountA = syncContacts().catch((error: unknown) => error);
    for (let i = 0; i < 10 && finishAccountA == null; i += 1) await Promise.resolve();
    expect(finishAccountA).toBeDefined();

    // Permission/contact reads are deliberately outside the teardown drain, so Disconnect can
    // finish immediately even while Android still owns the pending native promise.
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();

    const accountB = syncContacts();
    await expect(accountB).resolves.toEqual({ contacts: 0, matched: 0 });
    expect(getContactsAsync).toHaveBeenCalledTimes(2);
    expect(upsertContacts).toHaveBeenCalledTimes(1);
    expect(matchContactsToHandles).toHaveBeenCalledTimes(1);

    finishAccountA({ data: [] });
    expect(isContactsAccountChangedError(await accountA)).toBe(true);
    // A's late result never gets a DB phase after B has opened.
    expect(upsertContacts).toHaveBeenCalledTimes(1);
    expect(matchContactsToHandles).toHaveBeenCalledTimes(1);
  });

  it('drains an admitted DB statement, then stops before the next write after Disconnect', async () => {
    getContactsAsync.mockResolvedValue({ data: [] });
    let enteredCommit!: () => void;
    let finishCommit!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      enteredCommit = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    upsertContacts.mockImplementationOnce(
      async (
        _db: unknown,
        _items: unknown,
        runDbTask: (task: () => Promise<number>) => Promise<number>,
      ) =>
        runDbTask(async () => {
          enteredCommit();
          await commitGate;
          return 1;
        }),
    );

    const run = syncContacts().catch((error: unknown) => error);
    await commitEntered;

    let teardownFinished = false;
    const teardown = pauseRealtimeDeliveries().then(() => {
      teardownFinished = true;
    });
    await Promise.resolve();
    expect(teardownFinished).toBe(false);

    finishCommit();
    await teardown;
    expect(isContactsAccountChangedError(await run)).toBe(true);
    expect(matchContactsToHandles).not.toHaveBeenCalled();
    resumeRealtimeDeliveries();
  });

  /** IPC-01 containment: contact sync must never republish persistent chat names/photos. */
  describe('disabled Direct Share publication', () => {
    afterEach(() => {
      useSessionStore.getState().reset();
    });

    it('does not refresh shortcuts without a session', async () => {
      getContactsAsync.mockResolvedValue({ data: [] });
      useSessionStore.getState().reset();
      await syncContacts();
      expect(refreshShareShortcuts).not.toHaveBeenCalled();
    });

    it('does not refresh shortcuts even when names/photos change in a live session', async () => {
      getContactsAsync.mockResolvedValue({ data: [] });
      useSessionStore.getState().hydrated({ origin: 'https://server.example', password: 'pw' });
      await syncContacts();
      expect(refreshShareShortcuts).not.toHaveBeenCalled();
    });
  });
});
