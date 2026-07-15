/**
 * PinnedGrid (src/ui/conversations/PinnedGrid.tsx): the iOS pinned-conversations grid of large
 * avatars above the inbox list. Locked in:
 *   - renders NOTHING (null) for an empty rows array;
 *   - one labelled cell per pinned row, titled via `resolveTitle` (a11y "Pinned conversation: …");
 *   - tapping a cell fires onPress with the row GUID; long-press fires onLongPress with the ROW;
 *   - redacted mode masks the title to "Contact" and drops the real name (privacy).
 *
 * The avatars are the real primitives (Avatar/GroupAvatar); titles come from the pure `resolveTitle`
 * / `redactTitle` utils, so expected values are derived from those.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { PinnedGrid } from '@ui/conversations/PinnedGrid';
import { useRedactedModeStore } from '@state/redactedModeStore';
import type { InboxRow } from '@db/repositories';

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
    ...overrides,
  };
}

beforeEach(() => {
  useRedactedModeStore.setState({ enabled: false, hydrated: false });
});

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
    fireEvent.press(screen.getByLabelText('Pinned conversation: Alice'));
    expect(onPress).toHaveBeenCalledWith('g-alice');
  });

  it('fires onLongPress with the row when a cell is long-pressed', async () => {
    const onLongPress = jest.fn();
    const row = makeRow({ guid: 'g-alice', participantNames: 'Alice' });
    await renderWithTheme(
      <PinnedGrid rows={[row]} onPress={() => {}} onLongPress={onLongPress} />,
    );
    fireEvent(screen.getByLabelText('Pinned conversation: Alice'), 'longPress');
    expect(onLongPress).toHaveBeenCalledWith(row);
  });

  it('masks the title to "Contact" in redacted mode, hiding the real name', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(
      <PinnedGrid
        rows={[makeRow({ guid: 'g-alice', participantNames: 'Alice' })]}
        onPress={() => {}}
        onLongPress={() => {}}
      />,
    );
    expect(screen.getByText('Contact')).toBeTruthy();
    expect(screen.queryByText('Alice')).toBeNull();
    expect(screen.getByLabelText('Pinned conversation: Contact')).toBeTruthy();
  });
});
