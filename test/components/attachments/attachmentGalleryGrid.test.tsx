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
import { renderWithTheme, screen } from '../support/renderWithTheme';
import type { AttachmentRow } from '@db/repositories';

const mockCell = jest.fn();
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

function att(guid: string): AttachmentRow {
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
    localPath: null,
    service: null,
  };
}

describe('AttachmentGalleryGrid', () => {
  beforeEach(() => {
    mockCell.mockClear();
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
});
