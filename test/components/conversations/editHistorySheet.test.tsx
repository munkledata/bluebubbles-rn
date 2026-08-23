/**
 * EditHistorySheet (src/ui/conversations/EditHistorySheet.tsx): the "View Edit History" bottom
 * sheet listing a message's per-part revision timeline (Apple message_summary_info) plus a
 * "part removed" row for each unsent part. Locked in:
 *   - renders each revision as a labelled row (index 0 = "Original", later = "Edited") in
 *     original → current order, showing the revision text;
 *   - renders "Part N removed" (1-based) for each retractedParts index;
 *   - shows a part header ("Part N") only when there is more than one part;
 *   - an open sheet with no history shows the empty state; `data={null}` renders nothing.
 *
 * Prop-driven (the selection already carries the parsed history), so unlike ThreadSheet there is
 * NO DB fetch to mock — only `react-native-safe-area-context`. Renders inside a RN Modal whose
 * mount is async → assert the first hit via findBy.
 */
import React from 'react';
import { fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { MessageSummaryInfo } from '@core/models';
import { formatSeparatorDate } from '@utils';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { EditHistorySheet } from '@ui/conversations/EditHistorySheet';

const PRIVATE_ORIGINAL = 'private-edit-original-x-a91d@example.test';
const PRIVATE_EDITED = 'private-edit-final-x-7c91@example.test';
const HIDDEN = { includeHiddenElements: true } as const;

function regexFor(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function expectCanariesAbsent(tree: unknown, ...canaries: string[]): void {
  const json = JSON.stringify(tree);
  for (const canary of canaries) {
    expect(json).not.toContain(canary);
    expect(screen.queryByText(regexFor(canary), HIDDEN)).toBeNull();
    expect(screen.queryByLabelText(regexFor(canary))).toBeNull();
  }
}

const INFO: MessageSummaryInfo = {
  editedParts: {
    '0': [
      { date: 1_700_000_000_000, text: PRIVATE_ORIGINAL },
      { date: 1_700_000_100_000, text: PRIVATE_EDITED },
    ],
  },
  retractedParts: [1],
};

type SheetData = NonNullable<React.ComponentProps<typeof EditHistorySheet>['data']>;

function StatefulSheet({
  initialData,
  onClose,
}: {
  initialData: SheetData | null;
  onClose: () => void;
}): React.JSX.Element {
  const [data, setData] = React.useState<SheetData | null>(initialData);
  const close = React.useCallback(() => {
    onClose();
    setData(null);
  }, [onClose]);

  return <EditHistorySheet data={data} onClose={close} />;
}

describe('EditHistorySheet', () => {
  it('renders each revision (Original → Edited) with its text and a removed-part row', async () => {
    await renderWithTheme(<EditHistorySheet data={{ info: INFO }} onClose={jest.fn()} />);
    expect(await screen.findByText('Edit History')).toBeTruthy();
    expect(screen.getByText('Original')).toBeTruthy();
    expect(screen.getByText('Edited')).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_ORIGINAL })).toBeTruthy();
    expect(screen.getByRole('text', { name: PRIVATE_EDITED })).toBeTruthy();
    expect(screen.getByText(formatSeparatorDate(1_700_000_000_000))).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).toContain(PRIVATE_ORIGINAL);
    expect(JSON.stringify(screen.toJSON())).toContain(PRIVATE_EDITED);
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

  it('dismisses visible history through the real backdrop and clears parent-owned data', async () => {
    const onClose = jest.fn();
    const view = await renderWithTheme(
      <StatefulSheet initialData={{ info: INFO }} onClose={onClose} />,
    );
    expect(await screen.findByText(PRIVATE_ORIGINAL)).toBeTruthy();
    expect(screen.getByTestId('edit-history-backdrop')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('edit-history-backdrop'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Edit History', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('edit-history-backdrop')).toBeNull();
    expectCanariesAbsent(view.toJSON(), PRIVATE_ORIGINAL, PRIVATE_EDITED);
  });

  it('renders nothing when data is null (closed)', async () => {
    const onClose = jest.fn();
    await renderWithTheme(<EditHistorySheet data={null} onClose={onClose} />);
    await waitFor(() => expect(screen.queryByText('Edit History')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });
});
