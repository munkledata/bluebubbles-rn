import React from 'react';
import { fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockBack = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import LegalNoticesScreen from '../../../app/(app)/legal-notices';

describe('LegalNoticesScreen', () => {
  it('shows the canonical private terms, inherited notice, and honest open review gates', async () => {
    await renderWithTheme(<LegalNoticesScreen />);

    expect(screen.getByText(/Gator-authored source code and assets.*private/s)).toBeTruthy();
    expect(screen.getAllByText(/Google Play Internal Testing/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Copyright.*650 Industries/s)).toBeTruthy();
    expect(
      screen.getByText(/not legal approval or an exact Android App Bundle notice review/),
    ).toBeTruthy();
    expect(screen.getByText(/Broader distribution remains blocked/)).toBeTruthy();
  });

  it('returns through the standard accessible header control', async () => {
    await renderWithTheme(<LegalNoticesScreen />);

    fireEvent.press(screen.getByRole('button', { name: /back/i }));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
