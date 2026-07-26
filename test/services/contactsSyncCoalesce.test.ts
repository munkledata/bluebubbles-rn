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
const getContactsAsync = jest.fn();
const matchContactsToHandles = jest.fn();
const upsertContacts = jest.fn();
const refreshShareShortcuts = jest.fn();

jest.mock('expo-contacts/legacy', () => ({
  requestPermissionsAsync,
  getContactsAsync,
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

import { syncContacts } from '@/services/contacts/contactsService';
import { useSessionStore } from '@state/sessionStore';

// jest's clearMocks wipes call history but not implementations — re-arm both every test.
beforeEach(() => {
  requestPermissionsAsync.mockResolvedValue({ status: 'granted' });
  upsertContacts.mockResolvedValue(0);
  matchContactsToHandles.mockResolvedValue(0);
});

describe('syncContacts coalescing', () => {
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

  /**
   * This run is fired-and-forgotten from the tail of every sync, so it routinely outlives its
   * parent — and `awaitSyncIdle` explicitly does NOT wait for it, so it can still be running after
   * `forget()` has wiped the DB and dropped the Direct Share chips (which `runForget` does LAST).
   * Publishing then would put the previous account's conversation names and contact photos back
   * into the system share sheet, where nothing later clears them (a refresh over an emptied inbox
   * returns early rather than publishing zero). The absent session is the only thing that stops it.
   */
  describe('Direct Share chips', () => {
    afterEach(() => {
      useSessionStore.getState().reset();
    });

    it('are not re-published once the session is gone', async () => {
      getContactsAsync.mockResolvedValue({ data: [] });
      useSessionStore.getState().reset(); // what forget() does before it drains + wipes
      await syncContacts();
      expect(refreshShareShortcuts).not.toHaveBeenCalled();
    });

    it('are refreshed while a session exists (names/photos just changed)', async () => {
      getContactsAsync.mockResolvedValue({ data: [] });
      useSessionStore.getState().hydrated({ origin: 'https://server.example', password: 'pw' });
      await syncContacts();
      expect(refreshShareShortcuts).toHaveBeenCalledTimes(1);
    });
  });
});
