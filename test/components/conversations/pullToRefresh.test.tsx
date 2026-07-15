/**
 * usePullToRefresh (src/ui/primitives/PullToRefresh.tsx): the pull-to-refresh state hook +
 * ready-made themed `RefreshControl` element the lists hand to FlashList. This suite locks in the
 * behavioral CONTRACT the doc-comment promises:
 *   - `onRefresh` invokes `run`, raising `refreshing` until it settles;
 *   - an in-flight guard drops overlapping pulls (only ONE `run` runs at a time);
 *   - a rejected `run` is swallowed (logged) so the spinner always clears — never throws;
 *   - `progressViewOffset` is forwarded onto the RefreshControl element;
 *   - the two FlashList-v2 stability guarantees: `onRefresh` keeps a stable identity across
 *     re-renders, and the `refreshControl` element only changes identity when `refreshing` flips.
 *
 * Driven via `renderHook` (return value asserted directly), wrapped in a hydrated ThemeProvider
 * because the hook calls `useTheme()` for the spinner tint.
 */
import React, { type ReactNode } from 'react';
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import { ThemeProvider } from '@ui/theme/ThemeProvider';
import { useThemeStore } from '@state/themeStore';
import { DEFAULT_PRESET } from '@ui/theme/tokens';
import { usePullToRefresh } from '@ui/primitives/PullToRefresh';

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

beforeEach(() => {
  // ThemeProvider renders a blank placeholder until `hydrated`; seed it (the harness does this for
  // renderWithTheme, but renderHook bypasses that path).
  useThemeStore.setState({
    preset: DEFAULT_PRESET,
    customThemeId: null,
    customTokens: null,
    hydrated: true,
  });
});

describe('usePullToRefresh', () => {
  it('invokes run on refresh and clears the spinner when it resolves', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => usePullToRefresh(run), { wrapper });

    expect(result.current.refreshing).toBe(false);
    await act(async () => {
      result.current.onRefresh();
    });
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    // The element handed to FlashList reflects the settled state.
    expect(result.current.refreshControl.props.refreshing).toBe(false);
  });

  it('keeps the spinner up while run is pending and drops overlapping pulls (in-flight guard)', async () => {
    let release: (() => void) | undefined;
    const run = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = await renderHook(() => usePullToRefresh(run), { wrapper });

    // First pull starts run and raises the spinner.
    await act(async () => {
      result.current.onRefresh();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.refreshing).toBe(true);

    // A second pull WHILE the first is in flight is dropped — run is not called again.
    await act(async () => {
      result.current.onRefresh();
    });
    expect(run).toHaveBeenCalledTimes(1);

    // Settle the first run → spinner clears and a new pull is allowed again.
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    expect(result.current.refreshing).toBe(false);
  });

  it('swallows a rejected run and still clears the spinner (never throws)', async () => {
    const run = jest.fn().mockRejectedValue(new Error('sync failed'));
    const { result } = await renderHook(() => usePullToRefresh(run), { wrapper });

    await act(async () => {
      result.current.onRefresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('forwards progressViewOffset onto the RefreshControl element', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const { result } = await renderHook(() => usePullToRefresh(run, 42), { wrapper });
    expect(result.current.refreshControl.props.progressViewOffset).toBe(42);
  });

  it('exposes a STABLE onRefresh across re-renders (FlashList secondary-props stability)', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    const { result, rerender } = await renderHook(() => usePullToRefresh(run), { wrapper });
    const first = result.current.onRefresh;
    const firstControl = result.current.refreshControl;
    rerender(undefined);
    // onRefresh reads `run` through a ref → identity never changes.
    expect(result.current.onRefresh).toBe(first);
    // The element identity is memoized and only flips when `refreshing` changes (unchanged here).
    expect(result.current.refreshControl).toBe(firstControl);
  });
});
