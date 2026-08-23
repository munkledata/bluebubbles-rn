/**
 * AttachmentGalleryGrid (src/ui/attachments/AttachmentGalleryGrid.tsx): the iMessage-style
 * two-column grid a multi-image message collapses into. Locked in:
 *   - one ImageAttachment cell per attachment, all sharing the same cellSize and showTail=false
 *     (cells reuse the single-image component in cell mode);
 *   - the grid aligns to the sender's side (flex-end for own messages, flex-start for received).
 *
 * In-file mock: `@ui/attachments/ImageAttachment` (a Text marker capturing the props each cell
 * receives) so the grid renders without the download/network stack.
 */
import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { AttachmentRow } from '@db/repositories';

const mockCell = jest.fn();
const mockReleaseProtection = jest.fn();
const mockProtectPath = jest.fn<{ path: string; release: () => void } | null, [string]>((path) => ({
  path,
  release: mockReleaseProtection,
}));
jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: { protect: (path: string) => mockProtectPath(path) },
}));
jest.mock('@ui/attachments/ImageAttachment', () => {
  const RN = require('react-native');
  const r = require('react');
  return {
    ImageAttachment: (props: { att: { guid: string } }) => {
      mockCell(props);
      return r.createElement(RN.Text, null, 'CELL:' + props.att.guid);
    },
  };
});

// eslint-disable-next-line import/first
import { AttachmentGalleryGrid } from '@ui/attachments/AttachmentGalleryGrid';

function att(guid: string, localPath: string | null = null): AttachmentRow {
  return {
    id: 1,
    guid,
    messageId: 1,
    mimeType: 'image/jpeg',
    transferName: `${guid}.jpg`,
    totalBytes: 1000,
    height: 800,
    width: 600,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath,
    service: null,
  };
}

describe('AttachmentGalleryGrid', () => {
  beforeEach(() => {
    mockCell.mockClear();
    mockReleaseProtection.mockClear();
    mockProtectPath.mockReset().mockImplementation((path) => ({
      path,
      release: mockReleaseProtection,
    }));
  });

  it('renders one cell per attachment with a shared cellSize and no tail', async () => {
    await renderWithTheme(
      <AttachmentGalleryGrid atts={[att('a'), att('b'), att('c')]} isFromMe={false} />,
    );
    expect(screen.getByText('CELL:a')).toBeTruthy();
    expect(screen.getByText('CELL:b')).toBeTruthy();
    expect(screen.getByText('CELL:c')).toBeTruthy();
    expect(mockCell).toHaveBeenCalledTimes(3);
    const sizes = mockCell.mock.calls.map(([p]) => p.cellSize);
    expect(new Set(sizes).size).toBe(1); // every cell gets the SAME size
    expect(typeof sizes[0]).toBe('number');
    expect(mockCell.mock.calls.every(([p]) => p.showTail === false)).toBe(true);
  });

  it('aligns to the right for own messages', async () => {
    const view = await renderWithTheme(<AttachmentGalleryGrid atts={[att('a')]} isFromMe />);
    const root = view.toJSON() as unknown as { props: { style: StyleProp<ViewStyle> } };
    expect(StyleSheet.flatten(root.props.style).alignSelf).toBe('flex-end');
  });

  it('aligns to the left for received messages', async () => {
    const view = await renderWithTheme(
      <AttachmentGalleryGrid atts={[att('a')]} isFromMe={false} />,
    );
    const root = view.toJSON() as unknown as { props: { style: StyleProp<ViewStyle> } };
    expect(StyleSheet.flatten(root.props.style).alignSelf).toBe('flex-start');
  });

  it('gives every mounted cell its own pin and withholds a path whose pin is refused', async () => {
    mockProtectPath.mockImplementation((path) =>
      path.endsWith('/b.jpg') ? null : { path, release: mockReleaseProtection },
    );
    const view = await renderWithTheme(
      <AttachmentGalleryGrid
        atts={[att('a', 'file:///cache/a.jpg'), att('b', 'file:///cache/b.jpg')]}
        isFromMe={false}
      />,
    );

    expect(mockProtectPath).toHaveBeenCalledWith('file:///cache/a.jpg');
    expect(mockProtectPath).toHaveBeenCalledWith('file:///cache/b.jpg');
    await waitFor(() => {
      const latestA = [...mockCell.mock.calls]
        .reverse()
        .find(([props]) => props.att.guid === 'a')?.[0];
      const latestB = [...mockCell.mock.calls]
        .reverse()
        .find(([props]) => props.att.guid === 'b')?.[0];
      expect(latestA?.att.localPath).toBe('file:///cache/a.jpg');
      expect(latestB).toBeUndefined();
    });
    expect(screen.queryByText('CELL:b')).toBeNull();

    await view.unmount();
    expect(mockReleaseProtection).toHaveBeenCalledTimes(1);
  });
});
