/**
 * FileChip (src/ui/attachments/FileChip.tsx): the generic (non-image) attachment row —
 * a type-badge + filename + "TYPE • size" subtitle, with download-state affordances.
 * Behaviors locked in (values derived from src/utils/attachment.ts: fileTypeLabel / friendlySize):
 *   - filename comes from `transferName`, falling back to "File" when absent.
 *   - the type LABEL is fileTypeLabel(mime, name) — extension-first, uppercased; the badge shows
 *     its first 3 chars.
 *   - the subtitle is "LABEL • friendlySize" when totalBytes is set, else just "LABEL".
 *   - the download store drives the subtitle/badge: 'downloading' → "Downloading…" + spinner,
 *     'error' → "Tap to retry" + a refresh icon.
 *   - press dispatches: a downloaded chip (localPath set) opens the file via openAttachmentFile
 *     (which converts the app-private path to a content:// FileProvider uri) and does NOT
 *     re-download; an undownloaded chip calls download(att). The RESULT is consumed: 'missing'
 *     re-downloads, 'no_handler'/'error' toast, 'opened'/'shared' stay silent.
 *
 * In-file mocks: `@/services/download` (its barrel pulls `ky`, an untransformed ESM pkg — only the
 * `download` fn identity matters), `@ui/primitives` (Icon → a Text marker so the refresh icon is
 * queryable, and to keep native @expo/vector-icons out of the graph), and `safeOpenUrl` on the
 * `@utils` barrel — its REAL impl lazy-imports react-native via a dynamic `import()`, which throws
 * under the jest-expo VM, so the open contract is asserted at the safeOpenUrl boundary (exactly as
 * contactCard/locationCard do). fileTypeLabel/friendlySize stay REAL via requireActual. The real
 * download store is seeded via setState (never mocked).
 */
import React from 'react';
import { StyleSheet, type TextStyle } from 'react-native';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import { useUploadStore } from '@state/uploadStore';
import type { AttachmentRow } from '@db/repositories';

const mockDownload = jest.fn();
jest.mock('@/services/download', () => ({
  download: (att: unknown) => mockDownload(att),
  setAttachmentFetcher: jest.fn(),
  ensureDownloaded: jest.fn(),
}));
jest.mock('@ui/primitives', () => {
  const RN = require('react-native');
  const r = require('react');
  return {
    Icon: ({ name }: { name: string }) => r.createElement(RN.Text, null, 'ICON:' + name),
  };
});

// safeOpenUrl is mocked for ONE reason now: so the negative can be asserted. A local attachment
// path must never reach it (file:// is no longer allowlisted, and handing one to another app throws
// FileUriExposedException). fileTypeLabel/friendlySize stay REAL via requireActual.
jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));

// The open path itself. Mocked wholesale so no native module (expo-file-system /
// expo-intent-launcher / expo-sharing) enters this test's graph; its real behaviour is covered by
// the node test at test/services/openFile.test.ts.
const mockOpenAttachmentFile = jest.fn();
jest.mock('@/services/openFile', () => ({
  openAttachmentFile: (...args: unknown[]) => mockOpenAttachmentFile(...args),
}));

// eslint-disable-next-line import/first
import { FileChip } from '@ui/attachments/FileChip';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';

function makeAtt(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'att-1',
    messageId: 1,
    mimeType: 'application/pdf',
    transferName: 'report.pdf',
    totalBytes: 2_621_440, // 2.5 MB
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...over,
  };
}

beforeEach(() => {
  mockDownload.mockClear();
  (safeOpenUrl as jest.Mock).mockClear();
  useDownloadStore.setState({ progress: {}, status: {} });
  useUploadStore.setState({ byGuid: {} });
});

describe('FileChip — name + subtitle rendering', () => {
  it('shows the transferName and a "TYPE • size" subtitle for a sized PDF', async () => {
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('report.pdf')).toBeTruthy();
    // fileTypeLabel('application/pdf','report.pdf') = 'PDF'; friendlySize(2_621_440) = '2.5 MB'.
    expect(screen.getByText('PDF • 2.5 MB')).toBeTruthy();
  });

  it('falls back to "File" when transferName is null and derives the label from the mime type', async () => {
    await renderWithTheme(
      <FileChip att={makeAtt({ transferName: null, totalBytes: null })} isFromMe={false} />,
    );
    expect(screen.getByText('File')).toBeTruthy();
    // No totalBytes → subtitle is just the label; mime 'application/pdf' → 'PDF'. The badge glyph
    // (label.slice(0,3)) also reads "PDF", so both the badge and the subtitle render it → 2 nodes.
    expect(screen.getAllByText('PDF')).toHaveLength(2);
  });

  it('shows only the label (no size, no bullet) when totalBytes is absent', async () => {
    await renderWithTheme(<FileChip att={makeAtt({ totalBytes: null })} isFromMe={false} />);
    // Badge glyph + subtitle both read "PDF"; neither carries the "•" size separator.
    expect(screen.getAllByText('PDF')).toHaveLength(2);
    expect(screen.queryByText(/•/)).toBeNull();
  });

  it('uppercases a file extension as the type label (docx → DOCX)', async () => {
    await renderWithTheme(
      <FileChip
        att={makeAtt({
          transferName: 'notes.docx',
          mimeType: 'application/octet-stream',
          totalBytes: null,
        })}
        isFromMe={false}
      />,
    );
    expect(screen.getByText('DOCX')).toBeTruthy();
  });
});

describe('FileChip — download-state affordances', () => {
  it('shows "Downloading…" while the store status is downloading', async () => {
    useDownloadStore.setState({ status: { 'att-1': 'downloading' }, progress: {} });
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Downloading…')).toBeTruthy();
    // Not showing the resting size subtitle while in-flight.
    expect(screen.queryByText('PDF • 2.5 MB')).toBeNull();
  });

  it('shows "Tap to retry" + a refresh icon on an error status', async () => {
    useDownloadStore.setState({ status: { 'att-1': 'error' }, progress: {} });
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Tap to retry')).toBeTruthy();
    expect(screen.getByText('ICON:refresh-outline')).toBeTruthy();
  });
});

describe('FileChip — upload progress', () => {
  const uploading = (over: Partial<{ sent: number; total: number }> = {}) =>
    useUploadStore.setState({
      byGuid: {
        'att-1': {
          chatGuid: 'c1',
          name: 'report.pdf',
          sent: 512 * 1024,
          total: 2_621_440,
          updatedAt: 0,
          ...over,
        },
      },
    });

  it('replaces the resting subtitle with the byte readout + percentage while sending', async () => {
    uploading();
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe />);
    // friendlySize(512*1024) = '512 KB'; friendlySize(2_621_440) = '2.5 MB'; 512K/2.5M ≈ 20%.
    expect(screen.getByText('512 KB of 2.5 MB • 20%')).toBeTruthy();
    expect(screen.queryByText('PDF • 2.5 MB')).toBeNull();
  });

  it('omits the percentage until the total is known, keeping the size readout', async () => {
    uploading({ total: 0 });
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe />);
    expect(screen.getByText('512 KB')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('wins over a stale download status for the same guid', async () => {
    // A file we are SENDING came from this device and can never be downloading at the same time,
    // so a leftover download entry must not hide the upload readout.
    useDownloadStore.setState({ status: { 'att-1': 'downloading' }, progress: {} });
    uploading();
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe />);
    expect(screen.getByText('512 KB of 2.5 MB • 20%')).toBeTruthy();
    expect(screen.queryByText('Downloading…')).toBeNull();
  });

  it('drops back to the resting subtitle once the upload settles', async () => {
    // Settling REMOVES the entry — that removal is the whole "upload finished" signal, so a chip
    // rendered afterwards must show no trace of it.
    uploading();
    useUploadStore.getState().settle('att-1');
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe />);
    expect(screen.getByText('PDF • 2.5 MB')).toBeTruthy();
    expect(screen.queryByText(/of 2.5 MB •/)).toBeNull();
  });
});

describe('FileChip — press dispatch', () => {
  beforeEach(() => {
    useToastStore.setState({ current: null, queue: [] });
    // clearMocks:true clears calls but keeps implementations, so set the result per test.
    mockOpenAttachmentFile.mockResolvedValue({ status: 'opened' });
  });

  it('downloads on tap when the file is not yet local (and opens nothing)', async () => {
    const att = makeAtt({ localPath: null });
    await renderWithTheme(<FileChip att={att} isFromMe={false} />);
    fireEvent.press(screen.getByText('report.pdf'));
    expect(mockDownload).toHaveBeenCalledWith(att);
    expect(mockOpenAttachmentFile).not.toHaveBeenCalled();
  });

  // FAILS ON THE OLD CODE, which passed the raw file:// path to safeOpenUrl — a uri Android
  // forbids handing to another app, so the tap silently did nothing.
  it('routes a downloaded file through openAttachmentFile, never through safeOpenUrl', async () => {
    await renderWithTheme(
      <FileChip att={makeAtt({ localPath: 'file:///data/report.pdf' })} isFromMe={false} />,
    );
    fireEvent.press(screen.getByText('report.pdf'));
    expect(mockOpenAttachmentFile).toHaveBeenCalledWith('file:///data/report.pdf', 'application/pdf');
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('re-downloads when the local file turned out to be missing (self-heal)', async () => {
    mockOpenAttachmentFile.mockResolvedValue({ status: 'missing' });
    const att = makeAtt({ localPath: 'file:///data/report.pdf' });
    await renderWithTheme(<FileChip att={att} isFromMe={false} />);
    fireEvent.press(screen.getByText('report.pdf'));
    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith(att));
  });

  it('toasts when no app on the device can open the file', async () => {
    mockOpenAttachmentFile.mockResolvedValue({ status: 'no_handler' });
    await renderWithTheme(
      <FileChip att={makeAtt({ localPath: 'file:///data/report.pdf' })} isFromMe={false} />,
    );
    fireEvent.press(screen.getByText('report.pdf'));
    await waitFor(() => expect(useToastStore.getState().current?.message).toMatch(/No app/));
  });

  it('toasts on an unexpected open failure', async () => {
    mockOpenAttachmentFile.mockResolvedValue({ status: 'error' });
    await renderWithTheme(
      <FileChip att={makeAtt({ localPath: 'file:///data/report.pdf' })} isFromMe={false} />,
    );
    fireEvent.press(screen.getByText('report.pdf'));
    await waitFor(() => expect(useToastStore.getState().current?.message).toMatch(/open this file/));
  });

  // No toast for either success path. 'shared' deliberately stays silent: the share sheet is a
  // system window that appears immediately and IS the feedback, and AppToast is pointerEvents:'none'
  // behind it, so a toast there would be invisible and then gone.
  it.each(['opened', 'shared'] as const)('stays silent on a successful %s', async (status) => {
    mockOpenAttachmentFile.mockResolvedValue({ status });
    await renderWithTheme(
      <FileChip att={makeAtt({ localPath: 'file:///data/report.pdf' })} isFromMe={false} />,
    );
    fireEvent.press(screen.getByText('report.pdf'));
    await waitFor(() => expect(mockOpenAttachmentFile).toHaveBeenCalled());
    expect(useToastStore.getState().current).toBeNull();
    expect(useToastStore.getState().queue).toHaveLength(0);
  });
});

describe('FileChip — from-me alignment', () => {
  it('right-aligns the chip when the message is from me', async () => {
    await renderWithTheme(<FileChip att={makeAtt()} isFromMe />);
    // The Pressable is the ancestor carrying alignSelf; its child Text is queryable.
    const name = screen.getByText('report.pdf');
    // Walk up to the chip Pressable (the node whose style array carries alignSelf).
    let node: typeof name | null = name;
    let align: TextStyle['textAlign'] | undefined;
    while (node) {
      const flat = StyleSheet.flatten(node.props.style) as { alignSelf?: string };
      if (flat?.alignSelf) {
        align = flat.alignSelf as TextStyle['textAlign'];
        break;
      }
      node = node.parent as typeof name | null;
    }
    expect(align).toBe('flex-end');
  });
});
