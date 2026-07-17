/**
 * EditHistorySheet (src/ui/conversations/EditHistorySheet.tsx): the "View Edit History" bottom
 * sheet listing a message's per-part revision timeline (Apple message_summary_info) plus a
 * "part removed" row for each unsent part. Locked in:
 *   - renders each revision as a labelled row (index 0 = "Original", later = "Edited") in
 *     original → current order, showing the revision text;
 *   - renders "Part N removed" (1-based) for each retractedParts index;
 *   - shows a part header ("Part N") only when there is more than one part;
 *   - redacted mode masks every revision body to "Message" (AGENTS.md privacy rule — the sheet
 *     must not leak content a redacted bubble hides);
 *   - an open sheet with no history shows the empty state; `data={null}` renders nothing.
 *
 * Prop-driven (the selection already carries the parsed history), so unlike ThreadSheet there is
 * NO DB fetch to mock — only `react-native-safe-area-context`. Renders inside a RN Modal whose
 * mount is async → assert the first hit via findBy.
 */
import React from 'react';
import { renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { useRedactedModeStore } from '@state/redactedModeStore';
import type { MessageSummaryInfo } from '@core/models';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { EditHistorySheet } from '@ui/conversations/EditHistorySheet';

const INFO: MessageSummaryInfo = {
  editedParts: {
    '0': [
      { date: 1_700_000_000_000, text: 'first version' },
      { date: 1_700_000_100_000, text: 'final version' },
    ],
  },
  retractedParts: [1],
};

describe('EditHistorySheet', () => {
  beforeEach(() => {
    useRedactedModeStore.setState({ enabled: false });
  });

  it('renders each revision (Original → Edited) with its text and a removed-part row', async () => {
    await renderWithTheme(<EditHistorySheet data={{ info: INFO }} onClose={jest.fn()} />);
    expect(await screen.findByText('Edit History')).toBeTruthy();
    expect(screen.getByText('Original')).toBeTruthy();
    expect(screen.getByText('Edited')).toBeTruthy();
    expect(screen.getByText('first version')).toBeTruthy();
    expect(screen.getByText('final version')).toBeTruthy();
    // retractedParts [1] → 1-based "Part 2 removed".
    expect(screen.getByText('Part 2 removed')).toBeTruthy();
  });

  it('shows a part header for each part only when there is more than one part', async () => {
    const multi: MessageSummaryInfo = {
      editedParts: {
        '0': [{ date: 1, text: 'p0 v1' }],
        '1': [
          { date: 2, text: 'p1 v1' },
          { date: 3, text: 'p1 v2' },
        ],
      },
    };
    await renderWithTheme(<EditHistorySheet data={{ info: multi }} onClose={jest.fn()} />);
    expect(await screen.findByText('Part 1')).toBeTruthy();
    expect(screen.getByText('Part 2')).toBeTruthy();
    expect(screen.getByText('p0 v1')).toBeTruthy();
    expect(screen.getByText('p1 v2')).toBeTruthy();
  });

  it('omits the part header for a single-part message', async () => {
    await renderWithTheme(<EditHistorySheet data={{ info: INFO }} onClose={jest.fn()} />);
    expect(await screen.findByText('Edit History')).toBeTruthy();
    expect(screen.queryByText('Part 1')).toBeNull();
  });

  it('masks every revision body in redacted mode (no content leak)', async () => {
    useRedactedModeStore.setState({ enabled: true });
    await renderWithTheme(<EditHistorySheet data={{ info: INFO }} onClose={jest.fn()} />);
    expect(await screen.findByText('Edit History')).toBeTruthy();
    expect(screen.queryByText('first version')).toBeNull();
    expect(screen.queryByText('final version')).toBeNull();
    // Both revision bodies collapse to the generic placeholder.
    expect(screen.getAllByText('Message').length).toBe(2);
    // The structural labels still render.
    expect(screen.getByText('Original')).toBeTruthy();
  });

  it('shows the empty state when open with no synced history (e.g. an optimistic local edit)', async () => {
    await renderWithTheme(<EditHistorySheet data={{ info: null }} onClose={jest.fn()} />);
    expect(await screen.findByText('No edit history.')).toBeTruthy();
  });

  it('shows the empty state when editedParts + retractedParts are both empty', async () => {
    await renderWithTheme(
      <EditHistorySheet
        data={{ info: { editedParts: {}, retractedParts: [] } }}
        onClose={jest.fn()}
      />,
    );
    expect(await screen.findByText('No edit history.')).toBeTruthy();
  });

  it('renders nothing when data is null (closed)', async () => {
    await renderWithTheme(<EditHistorySheet data={null} onClose={jest.fn()} />);
    await waitFor(() => expect(screen.queryByText('Edit History')).toBeNull());
  });
});
