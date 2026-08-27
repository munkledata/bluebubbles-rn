import React from 'react';

const mockRedirect = jest.fn((_props: { href: string }) => null);

jest.mock('expo-router', () => ({
  Redirect: (props: { href: string }) => {
    mockRedirect(props);
    return null;
  },
}));
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));

// eslint-disable-next-line import/first
import Index from '../../../app/index';
// eslint-disable-next-line import/first
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { renderWithTheme } from '../support/renderWithTheme';

beforeEach(() => {
  mockRedirect.mockClear();
  useSessionStore.setState({
    status: 'connected',
    origin: 'https://onboarding-route.example',
    password: 'test-password',
  });
  useFeatureSettingsStore.setState({
    hydrated: true,
    permissionOnboardingCompleted: false,
  });
});

describe('Index permission-onboarding route guard', () => {
  it('returns an interrupted saved connection to the unfinished permission choices', async () => {
    await renderWithTheme(<Index />);

    expect(mockRedirect).toHaveBeenLastCalledWith({ href: '/permissions' });
  });

  it('routes a saved connection home after durable permission onboarding completion', async () => {
    useFeatureSettingsStore.setState({ permissionOnboardingCompleted: true });

    await renderWithTheme(<Index />);

    expect(mockRedirect).toHaveBeenLastCalledWith({ href: '/home' });
  });

  it('waits for account settings hydration before deciding a saved-session route', async () => {
    useFeatureSettingsStore.setState({ hydrated: false });

    await renderWithTheme(<Index />);

    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('still routes a connection-free launch to welcome without waiting on the account DB', async () => {
    useSessionStore.setState({
      status: 'unauthenticated',
      origin: null,
      password: null,
    });
    useFeatureSettingsStore.setState({ hydrated: false });

    await renderWithTheme(<Index />);

    expect(mockRedirect).toHaveBeenLastCalledWith({ href: '/welcome' });
  });
});
