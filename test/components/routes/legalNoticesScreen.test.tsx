import React from 'react';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockBack = jest.fn();
const mockSafeOpenUrl = jest.fn(async (_url: string) => true);

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('@utils', () => ({ safeOpenUrl: (url: string) => mockSafeOpenUrl(url) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import LegalNoticesScreen from '../../../app/(app)/legal-notices';

describe('LegalNoticesScreen', () => {
  beforeEach(() => {
    mockBack.mockClear();
    mockSafeOpenUrl.mockClear();
  });

  it('shows the canonical private terms, inherited notice, and honest open review gates', async () => {
    await renderWithTheme(<LegalNoticesScreen />);

    expect(screen.getByText(/Gator-authored source code and assets.*private/s)).toBeTruthy();
    expect(screen.getAllByText(/Google Play Internal Testing/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Copyright.*650 Industries/s)).toBeTruthy();
    expect(
      screen.getByText(/not legal approval or an exact Android App Bundle notice review/),
    ).toBeTruthy();
    expect(screen.getByText(/Broader distribution remains blocked/)).toBeTruthy();
    expect(screen.getByText(/Gator includes Google Maps features and content/)).toBeTruthy();
  });

  it('opens the required Google Maps terms and privacy destinations through the safe URL boundary', async () => {
    await renderWithTheme(<LegalNoticesScreen />);

    await act(async () => {
      fireEvent.press(
        screen.getByRole('button', { name: 'Open Google Maps End User Additional Terms' }),
      );
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Open Google Privacy Policy' }));
    });

    expect(mockSafeOpenUrl).toHaveBeenNthCalledWith(1, 'https://maps.google.com/help/terms_maps/');
    expect(mockSafeOpenUrl).toHaveBeenNthCalledWith(2, 'https://policies.google.com/privacy');
  });

  it('returns through the standard accessible header control', async () => {
    await renderWithTheme(<LegalNoticesScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: /back/i }));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
