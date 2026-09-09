import React from 'react';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockReplace = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import Syncing from '../../../app/(setup)/syncing';
// eslint-disable-next-line import/first
import { useSyncStore } from '@state/syncStore';
// eslint-disable-next-line import/first
import { createI18n } from '@utils/i18n';

beforeEach(() => {
  jest.clearAllMocks();
  useSyncStore.setState({ status: 'syncing', chats: 1, messages: 1, error: null });
});

describe('Syncing', () => {
  it('renders translated states with correct plurals and preserves routing', async () => {
    await renderWithTheme(<Syncing />);

    expect(screen.getByText('Syncing your messages…')).toBeTruthy();
    expect(screen.getByText('1 chat · 1 message')).toBeTruthy();

    await act(async () => {
      useSyncStore.setState({ chats: 1_234, messages: 2 });
    });
    expect(screen.getByText('1,234 chats · 2 messages')).toBeTruthy();

    await act(async () => {
      useSyncStore.setState({ status: 'error' });
    });
    expect(screen.getByText('Sync had trouble')).toBeTruthy();
    expect(screen.getByText(/Some messages may still be catching up/)).toBeTruthy();

    fireEvent.press(screen.getByText('Continue in Background'));
    expect(mockReplace).toHaveBeenCalledWith('/permissions');
  });

  it('pseudo-localizes catalog text without transforming formatted values', () => {
    const english = createI18n('en');
    const expanded = createI18n('en-XA');
    const mirrored = createI18n('ar-XB');
    const formattedNumber = expanded.number(1_234);
    const longEnglish = english.text('contactsPermission.dialog.rationale.message.share');
    const longExpanded = expanded.text('contactsPermission.dialog.rationale.message.share');

    expect(expanded.text('sync.title.complete')).not.toBe('Sync complete');
    expect(Array.from(longExpanded).length).toBeGreaterThanOrEqual(
      Math.ceil(Array.from(longEnglish).length * 1.3),
    );
    expect(
      expanded
        .count(1_234, 'sync.count.chat.one', 'sync.count.chat.other')
        .startsWith(`${formattedNumber} `),
    ).toBe(true);
    expect(mirrored.direction).toBe('rtl');
    expect(mirrored.text('sync.title.complete')).toContain('\u2067');
    expect(expanded.text('manual.field.url.placeholder')).toBe('https://your-server.ngrok.io');
    expect(expanded.text('manual.insecure.warning.protocol')).toBe('http://');
  });
});
