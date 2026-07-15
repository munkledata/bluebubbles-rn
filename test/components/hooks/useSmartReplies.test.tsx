/**
 * useSmartReplies (src/features/conversations/useSmartReplies.ts) — suggested-reply chips.
 * Locked-in contract:
 *   - suggestions are empty unless the feature is ENABLED (the real useSmartReplyStore.enabled flag)
 *     AND the newest message (index 0, newest-first) is an inbound, non-retracted text;
 *   - when eligible, it runs the REAL rule provider over the last 6 messages (oldest→newest) and
 *     surfaces its suggestions;
 *   - an own message (isFromMe===1) newest, a retracted newest, or no messages → empty;
 *   - recompute happens when the last inbound text changes.
 *
 * Per the harness rules the store is NOT mocked — enablement is driven via setState. The rule
 * provider (@core/smartReply, pure) runs for real, so this also pins the rule engine's output.
 */
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import { useSmartReplies } from '@features/conversations/useSmartReplies';
import type { EnrichedMessage } from '@features/conversations/useMessages';
import { useSmartReplyStore } from '@state/smartReplyStore';
import { mkMessage } from './_fixtures';

// newest-first arrays (index 0 = newest), as useMessages delivers.
const inboundGreeting = [mkMessage({ id: 2, isFromMe: 0, text: 'Hey there' })];

beforeEach(() => {
  // Real store; default enabled true. Reset explicitly (setup only resets the theme store).
  useSmartReplyStore.setState({ enabled: true, hydrated: true });
});

describe('useSmartReplies', () => {
  it('suggests replies for the newest inbound text when enabled', async () => {
    const { result } = await renderHook(() => useSmartReplies(inboundGreeting));
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    // Rule engine's greeting branch.
    expect(result.current).toEqual(['Hey!', 'Hello!', 'What’s up?']);
  });

  it('is empty when the feature is disabled', async () => {
    await act(async () => {
      useSmartReplyStore.setState({ enabled: false });
    });
    const { result } = await renderHook(() => useSmartReplies(inboundGreeting));
    // No await-for-non-empty: give the effect a tick and confirm it stays empty.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
  });

  it('is empty when the newest message is from me', async () => {
    const own = [mkMessage({ id: 3, isFromMe: 1, text: 'I said this last' })];
    const { result } = await renderHook(() => useSmartReplies(own));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
  });

  it('is empty when the newest inbound message was retracted', async () => {
    const retracted = [mkMessage({ id: 4, isFromMe: 0, text: 'oops', dateRetracted: 999 })];
    const { result } = await renderHook(() => useSmartReplies(retracted));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
  });

  it('is empty for no messages', async () => {
    const { result } = await renderHook(() => useSmartReplies([]));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
  });

  it('recomputes when a new inbound message arrives', async () => {
    const { result, rerender } = await renderHook(({ msgs }: { msgs: EnrichedMessage[] }) => useSmartReplies(msgs), {
      initialProps: { msgs: [mkMessage({ id: 1, isFromMe: 0, text: 'Are we still on?' })] },
    });
    await waitFor(() => expect(result.current).toEqual(['Yes', 'No', 'Maybe'])); // question branch

    await act(async () => {
      rerender({ msgs: [mkMessage({ id: 2, isFromMe: 0, text: 'thanks so much' })] });
    });
    await waitFor(() =>
      expect(result.current).toEqual(["You're welcome!", 'No problem', '👍']),
    ); // thanks branch
  });

  it('clears suggestions when the feature is turned off on a mounted tree', async () => {
    const { result } = await renderHook(() => useSmartReplies(inboundGreeting));
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));

    await act(async () => {
      useSmartReplyStore.setState({ enabled: false });
    });
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
