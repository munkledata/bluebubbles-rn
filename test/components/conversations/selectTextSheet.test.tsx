import React from 'react';
import { SelectTextSheet } from '@ui/conversations/SelectTextSheet';
import { fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('SelectTextSheet', () => {
  it('renders nothing while closed', async () => {
    await renderWithTheme(<SelectTextSheet text={null} onClose={jest.fn()} />);
    expect(screen.queryByText('Select Text')).toBeNull();
  });

  it('shows the whole message text as selectable text', async () => {
    const text = 'Dinner is at 7:30 at 123 Main St — the code is 4417.';
    await renderWithTheme(<SelectTextSheet text={text} onClose={jest.fn()} />);
    expect(screen.getByText('Select Text')).toBeTruthy();
    const body = screen.getByTestId('select-text-body');
    expect(body.props.selectable).toBe(true);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('closes from Done and from a tap outside the sheet', async () => {
    const onClose = jest.fn();
    await renderWithTheme(<SelectTextSheet text="hello" onClose={onClose} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    // The modal sheet keeps screen readers inside it (Done is their way out), so the backdrop
    // behind it is hidden from accessibility queries.
    await fireEvent.press(
      screen.getByTestId('select-text-backdrop', { includeHiddenElements: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
