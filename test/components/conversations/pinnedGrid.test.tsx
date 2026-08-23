/**
 * PinnedGrid (src/ui/conversations/PinnedGrid.tsx): the iOS pinned-conversations grid of large
 * avatars above the inbox list. Locked in:
 *   - renders NOTHING (null) for an empty rows array;
 *   - one labelled cell per pinned row, titled via `resolveTitle` (a11y "Pinned conversation: …");
 *   - tapping a cell fires onPress with the row GUID; long-press fires onLongPress with the ROW;
 *   - an unread pinned chat shows a dot AND says so in its a11y label (presence only, no count).
 *
 * The avatars are the real primitives (Avatar/GroupAvatar); titles come from the pure `resolveTitle`
 * utility, so expected values are derived from it.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';
import { PinnedGrid } from '@ui/conversations/PinnedGrid';
import type { InboxRow } from '@db/repositories';

const PRIVATE_GUID = 'iMessage;-;private-pinned-guid-7c91@example.test';
const PRIVATE_TITLE = 'private-pinned-title-4f22@example.test';
const PRIVATE_AVATAR_URI = 'file:///private-pinned-avatar-64e9-contact-photo.jpg';
const PRIVATE_GROUP_MEMBER_A = 'private-pinned-group-member-a-9f11@example.test';
const PRIVATE_GROUP_MEMBER_B = 'private-pinned-group-member-b-38da-+15557654321';
const PRIVATE_GROUP_AVATAR_A = 'file:///private-pinned-group-avatar-a-808d.jpg';
const PRIVATE_GROUP_AVATAR_B = 'file:///private-pinned-group-avatar-b-d197.jpg';

function regexFor(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function expectPrivateCanariesAbsent(tree: unknown, ...canaries: string[]): void {
  const json = JSON.stringify(tree);
  for (const canary of canaries) {
    expect(json).not.toContain(canary);
    expect(screen.queryByText(canary)).toBeNull();
    expect(screen.queryByLabelText(regexFor(canary))).toBeNull();
  }
}

function makeRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 1,
    guid: 'iMessage;-;+15551230000',
    chatIdentifier: '+15551230000',
    displayName: null,
    customName: null,
    customColor: null,
    style: 45, // 1:1
    isPinned: 1,
    isArchived: 0,
    muteType: null,
    latestMessageDate: 1_700_000_000_000,
    lastReadMessageGuid: null,
    lastText: 'hey there',
    lastSubject: null,
    lastIsFromMe: 0,
    lastHasAttachments: 0,
    lastDate: 1_700_000_000_000,
    lastGuid: 'm1',
    lastAssociatedType: null,
    lastError: 0,
    participantCount: 1,
    participantNames: 'Alice',
    participantAvatars: null,
    handleServices: null,
    unreadCount: 0,
    hasKnownSender: 1,
    ...overrides,
  };
}

describe('PinnedGrid', () => {
  it('renders nothing when there are no pinned rows', async () => {
    const view = await renderWithTheme(
      <PinnedGrid rows={[]} onPress={() => {}} onLongPress={() => {}} />,
    );
    expect(view.toJSON()).toBeNull();
  });

  it('renders a labelled cell per row, titled via resolveTitle', async () => {
    await renderWithTheme(
      <PinnedGrid
        rows={[
          makeRow({ guid: 'g-alice', participantNames: 'Alice' }),
          makeRow({ guid: 'g-bob', participantNames: 'Bob' }),
        ]}
        onPress={() => {}}
        onLongPress={() => {}}
      />,
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    expect(screen.getByLabelText('Pinned conversation: Alice')).toBeTruthy();
    expect(screen.getByLabelText('Pinned conversation: Bob')).toBeTruthy();
  });

  it('fires onPress with the row guid when a cell is tapped', async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <PinnedGrid
        rows={[makeRow({ guid: 'g-alice', participantNames: 'Alice' })]}
        onPress={onPress}
        onLongPress={() => {}}
      />,
    );
    await fireEvent.press(screen.getByLabelText('Pinned conversation: Alice'));
    expect(onPress).toHaveBeenCalledWith('g-alice');
  });

  it('fires onLongPress with the row when a cell is long-pressed', async () => {
    const onLongPress = jest.fn();
    const row = makeRow({ guid: 'g-alice', participantNames: 'Alice' });
    await renderWithTheme(<PinnedGrid rows={[row]} onPress={() => {}} onLongPress={onLongPress} />);
    await fireEvent(screen.getByLabelText('Pinned conversation: Alice'), 'longPress');
    expect(onLongPress).toHaveBeenCalledWith(row);
  });

  // The grid has no preview, timestamp or badge, so before the dot a pinned chat gave the user no
  // signal at all that it had unread messages — and it's the ListHeaderComponent, i.e. the first
  // thing they look at.
  it('shows an unread dot and announces it, only when the row has unread messages', async () => {
    const unreadGuid = 'private-unread-guid-a11c@example.test';
    const secondUnreadGuid = 'private-unread-guid-c93f@example.test';
    const readGuid = 'private-read-guid-b02d@example.test';
    const view = await renderWithTheme(
      <PinnedGrid
        rows={[
          makeRow({ guid: unreadGuid, participantNames: 'Alice', unreadCount: 3 }),
          makeRow({ guid: secondUnreadGuid, participantNames: 'Carol', unreadCount: 8 }),
          makeRow({ guid: readGuid, participantNames: 'Bob', unreadCount: 0 }),
        ]}
        onPress={() => {}}
        onLongPress={() => {}}
      />,
    );
    const unreadDots = [
      screen.getByTestId('pinned-unread-0'),
      screen.getByTestId('pinned-unread-1'),
    ];
    expect(screen.queryByTestId('pinned-unread-2')).toBeNull();
    expect(screen.queryByTestId(regexFor(unreadGuid))).toBeNull();
    for (const dot of unreadDots) {
      expect(StyleSheet.flatten(dot.props.style)).toMatchObject({
        position: 'absolute',
        width: 16,
        height: 16,
        borderWidth: 2,
      });
    }
    expectPrivateCanariesAbsent(view.toJSON(), unreadGuid, secondUnreadGuid, readGuid);
    // Presence only — the count must NOT leak into the label or the cell.
    expect(screen.getByLabelText('Pinned conversation: Alice, unread')).toBeTruthy();
    expect(screen.getByLabelText('Pinned conversation: Carol, unread')).toBeTruthy();
    expect(screen.getByLabelText('Pinned conversation: Bob')).toBeTruthy();
    expect(screen.queryByText('3')).toBeNull();
    expect(screen.queryByText('8')).toBeNull();
  });

  it('renders an exact 1:1 title and photo while retaining exact guid and row callbacks', async () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    const row = makeRow({
      guid: PRIVATE_GUID,
      customName: PRIVATE_TITLE,
      participantNames: 'private-pinned-member-a31d@example.test',
      participantAvatars: PRIVATE_AVATAR_URI,
    });
    const view = await renderWithTheme(
      <PinnedGrid rows={[row]} onPress={onPress} onLongPress={onLongPress} />,
    );
    expect(screen.getByText(PRIVATE_TITLE)).toBeTruthy();
    const cell = screen.getByLabelText(`Pinned conversation: ${PRIVATE_TITLE}`);
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_AVATAR_URI);
    await fireEvent.press(cell);
    await fireEvent(cell, 'longPress');
    expect(onPress).toHaveBeenCalledWith(PRIVATE_GUID);
    expect(onLongPress).toHaveBeenCalledWith(row);
  });

  it('renders exact group member title and both participant photos', async () => {
    const title = `${PRIVATE_GROUP_MEMBER_A}, ${PRIVATE_GROUP_MEMBER_B}`;
    const row = makeRow({
      guid: PRIVATE_GUID,
      style: 43,
      participantCount: 2,
      customName: null,
      participantNames: title,
      participantAvatars: `${PRIVATE_GROUP_AVATAR_A}|||${PRIVATE_GROUP_AVATAR_B}`,
    });
    const view = await renderWithTheme(
      <PinnedGrid rows={[row]} onPress={() => {}} onLongPress={() => {}} />,
    );

    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByLabelText(`Pinned conversation: ${title}`)).toBeTruthy();
    const tree = JSON.stringify(view.toJSON());
    expect(tree).toContain(PRIVATE_GROUP_AVATAR_A);
    expect(tree).toContain(PRIVATE_GROUP_AVATAR_B);
  });
});
