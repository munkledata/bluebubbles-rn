import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { ChatStatsSection } from '@ui/conversations/ChatStatsSection';

const stats = {
  sent: 1234,
  received: 2000,
  photos: 120,
  videos: 8,
  otherFiles: 12,
  firstMessageAt: Date.UTC(2024, 2, 3, 12),
};

describe('ChatStatsSection', () => {
  it('shows counts on this phone and the first message date', async () => {
    await renderWithTheme(<ChatStatsSection stats={stats} />);
    expect(screen.getByText('STATS')).toBeTruthy();
    expect(screen.getByText('1,234 sent · 2,000 received')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Mar 3, 2024')).toBeTruthy();
    expect(screen.getByText(/stored on this phone/)).toBeTruthy();
  });

  it('shows nothing while loading or for a chat with no stored messages', async () => {
    const view = await renderWithTheme(<ChatStatsSection stats={null} />);
    expect(view.toJSON()).toBeNull();
    await view.rerender(<ChatStatsSection stats={{ ...stats, sent: 0, received: 0 }} />);
    expect(view.toJSON()).toBeNull();
  });

  it('leaves out the date when none is stored', async () => {
    await renderWithTheme(<ChatStatsSection stats={{ ...stats, firstMessageAt: null }} />);
    expect(screen.queryByText('First message')).toBeNull();
  });
});
