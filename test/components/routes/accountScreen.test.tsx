/**
 * The old account route remains only as a safe destination for stale bookmarks/deep links.
 * Injected legacy capability flags must not restore its helper-backed GET or POST calls.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';

const mockBack = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({
  http: { get: jest.fn(), post: jest.fn() },
}));

// eslint-disable-next-line import/first
import AccountScreen from '../../../app/(app)/account';
// eslint-disable-next-line import/first
import { http } from '@/services';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

describe('AccountScreen — retired helper feature', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSessionStore.setState({
      serverInfo: {
        version: 'legacy',
        private_api: true,
        supports_icloud_account: true,
      } as never,
    });
  });

  it('shows only the retired explanation and never contacts the legacy account endpoints', async () => {
    await renderWithTheme(<AccountScreen />);

    expect(screen.getByText(/retired in this Gator release/i)).toBeTruthy();
    expect(screen.queryByText('Apple ID')).toBeNull();
    expect(http.get).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
  });

  it('keeps Back available for stale deep links', async () => {
    await renderWithTheme(<AccountScreen />);

    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
