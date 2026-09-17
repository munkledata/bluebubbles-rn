import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import FaceTimeScreen from '../../../app/(app)/facetime';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

it('shows only retirement information under injected private_api:true', async () => {
  useSessionStore.setState({ serverInfo: { version: 'old', private_api: true } as any });

  await renderWithTheme(<FaceTimeScreen />);

  expect(screen.getByText('FaceTime calling from Gator was retired in this release.')).toBeTruthy();
  expect(screen.queryByLabelText('Start FaceTime call')).toBeNull();
  expect(screen.queryByPlaceholderText(/phone or email/i)).toBeNull();
});
