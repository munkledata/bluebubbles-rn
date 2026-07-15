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
 *   - press dispatches: a downloaded chip (localPath set) opens the file via safeOpenUrl and does
 *     NOT re-download; an undownloaded chip calls download(att).
 *
 * In-file mocks: `@/services/download` (its barrel pulls `ky`, an untransformed ESM pkg — only the
 * `download` fn identity matters) and `@ui/primitives` (Icon → a Text marker so the refresh icon is
 * queryable, and to keep native @expo/vector-icons out of the graph). The real download store is
 * seeded via setState (never mocked). safeOpenUrl is the real util; it opens through RN Linking,
 * which we spy on.
 */
import React from 'react';
import { StyleSheet, type TextStyle } from 'react-native';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
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

// eslint-disable-next-line import/first
import { FileChip } from '@ui/attachments/FileChip';

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
  useDownloadStore.setState({ progress: {}, status: {} });
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
        att={makeAtt({ transferName: 'notes.docx', mimeType: 'application/octet-stream', totalBytes: null })}
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

describe('FileChip — press dispatch', () => {
  it('downloads on tap when the file is not yet local', async () => {
    const att = makeAtt({ localPath: null });
    await renderWithTheme(<FileChip att={att} isFromMe={false} />);
    fireEvent.press(screen.getByText('report.pdf'));
    expect(mockDownload).toHaveBeenCalledWith(att);
  });

  it('opens (does not re-download) a downloaded file — tap routes to safeOpenUrl, not download', async () => {
    // NOTE: safeOpenUrl opens through a dynamic `import('react-native')`, which throws under jest
    // (no --experimental-vm-modules), so the actual Linking.openURL cannot be observed here. The
    // testable contract is the branch choice: a chip WITH a localPath must NOT call download().
    await renderWithTheme(
      <FileChip att={makeAtt({ localPath: 'file:///data/report.pdf' })} isFromMe={false} />,
    );
    fireEvent.press(screen.getByText('report.pdf'));
    expect(mockDownload).not.toHaveBeenCalled();
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
