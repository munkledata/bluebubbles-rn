/**
 * useNewScreenEffect (src/features/conversations/useNewScreenEffect.ts) — returns a full-screen
 * effect to play when a NEW message carrying one arrives while the chat is open. Locked-in contract:
 *   - history is BASELINED on first run: an existing newest message (even one with an effect style)
 *     never replays on open;
 *   - a strictly-newer message id carrying a mappable screen style fires the effect ONCE;
 *   - the same newest (no id increase) does not re-fire (the once-only guard);
 *   - a newer message with no/unknown style produces no effect;
 *   - `clear()` resets the effect to null;
 *   - a chatGuid change re-baselines (the ref reset) so a reused screen can't suppress effects.
 *
 * screenEffectOf (@core/effects, pure) runs for real, so the id→effect mapping is pinned too.
 * No DB or timers are involved.
 */
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import { useNewScreenEffect } from '@features/conversations/useNewScreenEffect';
import { mkMessage } from './_fixtures';

const CONFETTI = 'com.apple.messages.effect.CKConfettiEffect';
const LASERS = 'com.apple.messages.effect.CKLasersEffect';

type Msgs = ReturnType<typeof mkMessage>[];

// newest-first arrays (index 0 = newest).
function feed(...msgs: Parameters<typeof mkMessage>[0][]): Msgs {
  return msgs.map((m) => mkMessage(m));
}

describe('useNewScreenEffect', () => {
  it('baselines existing history: no effect on open even with an effect style present', async () => {
    const { result } = await renderHook(
      ({ msgs }: { msgs: Msgs }) => useNewScreenEffect('c1', msgs),
      { initialProps: { msgs: feed({ id: 5, expressiveSendStyleId: CONFETTI }) } },
    );
    // First run only records the baseline id — nothing plays.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.effect).toBeNull();
  });

  it('fires ONCE for a strictly-newer message carrying a mappable screen style', async () => {
    const { result, rerender } = await renderHook(
      ({ msgs }: { msgs: Msgs }) => useNewScreenEffect('c1', msgs),
      { initialProps: { msgs: feed({ id: 5, expressiveSendStyleId: null }) } },
    );
    await act(async () => {
      rerender({ msgs: feed({ id: 6, expressiveSendStyleId: CONFETTI }) });
    });
    await waitFor(() => expect(result.current.effect).toBe('confetti'));
  });

  it('does not re-fire when the newest id is unchanged', async () => {
    const { result, rerender } = await renderHook(
      ({ msgs }: { msgs: Msgs }) => useNewScreenEffect('c1', msgs),
      { initialProps: { msgs: feed({ id: 5 }) } },
    );
    await act(async () => {
      rerender({ msgs: feed({ id: 6, expressiveSendStyleId: LASERS }) });
    });
    await waitFor(() => expect(result.current.effect).toBe('lasers'));

    // Clear, then re-render with the SAME newest id — the guard means no new effect.
    await act(async () => {
      result.current.clear();
    });
    await waitFor(() => expect(result.current.effect).toBeNull());
    await act(async () => {
      rerender({ msgs: feed({ id: 6, expressiveSendStyleId: LASERS }) });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.effect).toBeNull();
  });

  it('produces no effect for a newer message with an unknown/absent style', async () => {
    const { result, rerender } = await renderHook(
      ({ msgs }: { msgs: Msgs }) => useNewScreenEffect('c1', msgs),
      { initialProps: { msgs: feed({ id: 5 }) } },
    );
    await act(async () => {
      rerender({ msgs: feed({ id: 7, expressiveSendStyleId: 'com.apple.unknown.effect' }) });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.effect).toBeNull();
  });

  it('clear() resets a fired effect to null', async () => {
    const { result, rerender } = await renderHook(
      ({ msgs }: { msgs: Msgs }) => useNewScreenEffect('c1', msgs),
      { initialProps: { msgs: feed({ id: 5 }) } },
    );
    await act(async () => {
      rerender({ msgs: feed({ id: 6, expressiveSendStyleId: CONFETTI }) });
    });
    await waitFor(() => expect(result.current.effect).toBe('confetti'));
    await act(async () => {
      result.current.clear();
    });
    await waitFor(() => expect(result.current.effect).toBeNull());
  });

  it('re-baselines when the chatGuid changes (a reused screen cannot suppress effects)', async () => {
    const { result, rerender } = await renderHook(
      ({ guid, msgs }: { guid: string; msgs: Msgs }) => useNewScreenEffect(guid, msgs),
      { initialProps: { guid: 'c1', msgs: feed({ id: 5, expressiveSendStyleId: CONFETTI }) } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.effect).toBeNull(); // baselined for c1

    // Switch chats: the ref resets, so the current newest is re-baselined (no replay)...
    await act(async () => {
      rerender({ guid: 'c2', msgs: feed({ id: 8, expressiveSendStyleId: CONFETTI }) });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.effect).toBeNull();

    // ...and a genuinely newer message in the new chat still fires.
    await act(async () => {
      rerender({ guid: 'c2', msgs: feed({ id: 9, expressiveSendStyleId: LASERS }) });
    });
    await waitFor(() => expect(result.current.effect).toBe('lasers'));
  });

  it('produces no effect when there are no messages', async () => {
    const { result } = await renderHook(
      ({ msgs }: { msgs: Msgs }) => useNewScreenEffect('c1', msgs),
      {
        initialProps: { msgs: [] as ReturnType<typeof mkMessage>[] },
      },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.effect).toBeNull();
  });
});
