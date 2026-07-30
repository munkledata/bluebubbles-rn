/**
 * UploadStatusBar (src/ui/conversations/UploadStatusBar.tsx): the slim summary bar above the
 * composer, showing what this chat is currently sending.
 *
 * Behaviors locked in:
 *   - renders NOTHING when nothing is uploading, and nothing for another chat's uploads (the bar
 *     belongs to the thread on screen);
 *   - one file names it; several are counted;
 *   - the byte readout drops its percentage while any total is still unknown;
 *   - an upload that has gone silent shows the stall warning instead of numbers;
 *   - settling an entry removes the bar — that removal is the whole "upload finished" signal.
 *
 * The stall case is driven by an `updatedAt` already in the past, so it is asserted WITHOUT fake
 * timers: the component seeds its clock from Date.now() on first render, so a stale timestamp is
 * stalled immediately. The 1 s interval only controls WHEN a stall is noticed, not what is shown.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, renderWithTheme, screen } from '../support/renderWithTheme';
import { UploadStatusBar } from '@ui/conversations/UploadStatusBar';
import { useUploadStore, type UploadEntry } from '@state/uploadStore';

const KB = 1024;
const MB = 1024 * 1024;

function entry(over: Partial<UploadEntry> = {}): UploadEntry {
  return {
    chatGuid: 'c1',
    name: 'photo.jpg',
    sent: 512 * KB,
    total: MB,
    updatedAt: Date.now(),
    ...over,
  };
}

const seed = (byGuid: Record<string, UploadEntry>) => useUploadStore.setState({ byGuid });

beforeEach(() => {
  useUploadStore.setState({ byGuid: {} });
});

describe('UploadStatusBar — visibility', () => {
  it('renders nothing when no upload is in flight', async () => {
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.queryByText(/Sending/)).toBeNull();
  });

  it('ignores uploads belonging to a different chat', async () => {
    seed({ a1: entry({ chatGuid: 'other-chat' }) });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.queryByText(/Sending/)).toBeNull();
  });

  it('disappears once the upload settles', async () => {
    seed({ a1: entry() });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.getByText('Sending photo.jpg')).toBeTruthy();

    await act(async () => {
      useUploadStore.getState().settle('a1');
    });
    expect(screen.queryByText(/Sending/)).toBeNull();
  });
});

describe('UploadStatusBar — readout', () => {
  it('names a single file and shows bytes + percentage', async () => {
    seed({ a1: entry() });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.getByText('Sending photo.jpg')).toBeTruthy();
    expect(screen.getByText('512 KB of 1 MB · 50%')).toBeTruthy();
  });

  it('counts multiple files and aggregates their bytes', async () => {
    seed({
      a1: entry({ sent: 100, total: 400 }),
      a2: entry({ name: 'clip.mp4', sent: 100, total: 600 }),
    });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.getByText('Sending 2 files')).toBeTruthy();
    expect(screen.getByText(/20%/)).toBeTruthy(); // 200 of 1000
  });

  it('omits the percentage while a total is still unknown', async () => {
    seed({ a1: entry({ total: 0 }) });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.getByText('512 KB')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('counts only the uploads for THIS chat when several chats are sending', async () => {
    seed({
      a1: entry(),
      a2: entry({ chatGuid: 'other-chat', name: 'elsewhere.jpg' }),
    });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    // One file for this chat → named, not counted.
    expect(screen.getByText('Sending photo.jpg')).toBeTruthy();
  });
});

describe('UploadStatusBar — stall', () => {
  it('warns when an upload has gone silent', async () => {
    seed({ a1: entry({ updatedAt: Date.now() - 60_000 }) });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.getByText('Stalled — check your connection')).toBeTruthy();
    // The byte count is replaced, not joined — it is precisely what stopped moving.
    expect(screen.queryByText(/512 KB of/)).toBeNull();
  });

  it('does not warn about an upload that simply has not reported yet', async () => {
    seed({ a1: entry({ updatedAt: 0, sent: 0 }) });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.queryByText(/Stalled/)).toBeNull();
  });
});

describe('UploadStatusBar — wallpaper chrome', () => {
  it('frosts itself over a chat wallpaper instead of drawing an opaque bar', async () => {
    // Over a wallpaper the composer bar goes transparent and its controls float as frosted chips;
    // an opaque strip here would cut the photo in half. The border goes too, for the same reason.
    seed({ a1: entry() });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" translucent />);
    const style = StyleSheet.flatten(screen.getByRole('progressbar').props.style) as {
      backgroundColor: string;
      borderTopColor: string;
    };
    expect(style.borderTopColor).toBe('transparent');
    // withAlpha(bg, 0.62) — a translucent value, never the flat theme background.
    expect(style.backgroundColor).not.toBe('#000000');
    expect(style.backgroundColor.length).toBeGreaterThan(7); // #rrggbb + alpha
  });

  it('is a solid bar with a separator when there is no wallpaper', async () => {
    seed({ a1: entry() });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    const style = StyleSheet.flatten(screen.getByRole('progressbar').props.style) as {
      borderTopColor: string;
    };
    expect(style.borderTopColor).not.toBe('transparent');
  });
});

describe('UploadStatusBar — accessibility', () => {
  it('exposes itself as a progressbar carrying both lines and the percentage', async () => {
    seed({ a1: entry() });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.props.accessibilityLabel).toBe('Sending photo.jpg. 512 KB of 1 MB · 50%');
    expect(bar.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 50 });
  });

  it('reports no numeric value while the total is unknown', async () => {
    seed({ a1: entry({ total: 0 }) });
    await renderWithTheme(<UploadStatusBar chatGuid="c1" />);
    expect(screen.getByRole('progressbar').props.accessibilityValue).toBeUndefined();
  });
});
