/**
 * Dormant inbound-share navigation consumer.
 *
 * IPC-01 keeps this component unmounted until an owned native intake can enforce streaming byte,
 * aggregate, count, cancellation, and duration limits. These tests preserve the platform-free
 * consumer behavior without linking or mocking the unsafe `expo-share-intent` package.
 */
import React from 'react';
import { act } from '@testing-library/react-native';
import { renderWithTheme } from './support/renderWithTheme';
import { logger } from '@core/secure';
import { useShareIntentStore } from '@state/shareIntentStore';

const mockPush = jest.fn();
const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => '/home',
}));
// eslint-disable-next-line import/first
import { ShareIntentNavigator } from '@ui/ShareIntentHandler';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ShareIntentNavigator (dormant future consumer)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    useShareIntentStore.setState({ text: null, files: [] });
  });

  it('does not navigate when the store is empty', async () => {
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens /new-chat once for a pending shared file', async () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    useShareIntentStore.setState({
      text: null,
      files: [{ uri: 'file:///x.jpg', name: 'x.jpg', mimeType: 'image/jpeg', size: 1 }],
    });
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/new-chat');
    expect(debug).toHaveBeenCalledWith('[share] opening new-chat for pending share');
  });

  it('opens /new-chat for pending shared text', async () => {
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    useShareIntentStore.setState({ text: 'hi', files: [] });
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).toHaveBeenCalledWith('/new-chat');
    expect(debug).toHaveBeenCalledWith('[share] opening new-chat for pending share');
  });

  it('re-arms after the store is cleared', async () => {
    jest.spyOn(logger, 'debug').mockImplementation(() => {});
    useShareIntentStore.setState({ text: 'first', files: [] });
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    await act(async () => {
      useShareIntentStore.setState({ text: null, files: [] });
    });
    await act(async () => {
      useShareIntentStore.setState({ text: 'second', files: [] });
    });
    expect(mockPush).toHaveBeenCalledTimes(2);
  });
});
