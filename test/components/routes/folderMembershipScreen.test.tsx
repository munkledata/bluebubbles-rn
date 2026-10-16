/**
 * Folder membership route (review M244): load, toggle, the per-folder limit, every save outcome
 * and the unread-badge setting. The services are faked; the screen's own logic runs for real.
 */
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { InboxRow } from '@db/repositories';

const mockBack = jest.fn();
let mockFolderParam: string | undefined = '7';
const mockAccountLease = { generation: 3, isCurrent: () => true };
let mockChats: {
  data: Partial<InboxRow>[];
  hasMore: boolean;
  loadMore: () => void;
  isLoading: boolean;
  error: unknown;
};

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  return {
    useRouter: () => ({ back: mockBack }),
    useLocalSearchParams: () => ({ id: mockFolderParam }),
    useFocusEffect: (callback: () => void | (() => void)) =>
      ReactLib.useEffect(callback, [callback]),
  };
});
jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    FlashList: (props: {
      data: { guid: string }[];
      renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) =>
      ReactLib.createElement(
        View,
        null,
        props.data.length === 0
          ? props.ListEmptyComponent
          : props.data.map((item, index) =>
              ReactLib.createElement(
                ReactLib.Fragment,
                { key: item.guid },
                props.renderItem({ item, index }),
              ),
            ),
      ),
  };
});
// A small per-folder limit makes the limit branch reachable with three conversations.
jest.mock('@db/repositories', () => ({ MAX_CUSTOM_FOLDER_MEMBERS: 2 }));
jest.mock('@features/conversations/useChats', () => ({ useChats: () => mockChats }));
jest.mock('@/services/customFolderCommands', () => {
  // The limit error and the total are the real ones; only the database commands are faked.
  const { CustomFolderMembershipLimitError, MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL } =
    jest.requireActual<typeof import('@db/repositories/customFolders')>(
      '@db/repositories/customFolders',
    );
  return {
    CustomFolderMembershipLimitError,
    MAX_CUSTOM_FOLDER_MEMBERSHIPS_TOTAL,
    loadCustomFolders: jest.fn(),
    loadCustomFolderMembership: jest.fn(),
    replaceCustomFolderMembership: jest.fn(),
    setCustomFolderShowUnreadBadge: jest.fn(),
  };
});
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  subscribeRealtimeGenerationInvalidation: () => () => undefined,
}));
jest.mock('@ui/hooks/useScreenAccountLease', () => ({
  useScreenAccountLease: () => mockAccountLease,
}));
jest.mock('@ui/hooks/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => ({ navigateWithoutPrompt: (navigate: () => void) => navigate() }),
}));
jest.mock('@ui/conversations/FilteredChatListScreen', () => ({ InboxSeparator: () => null }));
jest.mock('@ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text, View } = require('react-native');
  return {
    Avatar: () => null,
    readableTextOn: () => '#ffffff',
    useTheme: () => ({
      color: {
        tint: '#0088ff',
        label: '#111111',
        secondaryLabel: '#555555',
        tertiaryLabel: '#888888',
        separator: '#cccccc',
        destructive: '#cc0000',
      },
    }),
    Screen: ({ children }: { children?: React.ReactNode }) =>
      ReactLib.createElement(View, null, children),
    ScreenHeader: ({ title, right }: { title: string; right?: React.ReactNode }) =>
      ReactLib.createElement(View, null, ReactLib.createElement(Text, null, title), right),
    SettingsSection: ({ children }: { children?: React.ReactNode }) =>
      ReactLib.createElement(View, null, children),
    SwitchRow: (props: {
      value: boolean;
      disabled?: boolean;
      accessibilityLabel: string;
      onValueChange: (value: boolean) => void;
    }) =>
      ReactLib.createElement(Pressable, {
        accessibilityRole: 'switch',
        accessibilityLabel: props.accessibilityLabel,
        accessibilityState: { checked: props.value, disabled: props.disabled === true },
        disabled: props.disabled,
        onPress: () => props.onValueChange(!props.value),
      }),
  };
});

// eslint-disable-next-line import/first
import ConversationFolderMembershipScreen from '../../../app/(app)/folders/[id]';
// eslint-disable-next-line import/first
import {
  CustomFolderMembershipLimitError,
  loadCustomFolderMembership,
  loadCustomFolders,
  replaceCustomFolderMembership,
  setCustomFolderShowUnreadBadge,
} from '@/services/customFolderCommands';

const mockLoadFolders = jest.mocked(loadCustomFolders);
const mockLoadMembership = jest.mocked(loadCustomFolderMembership);
const mockReplace = jest.mocked(replaceCustomFolderMembership);
const mockSetBadge = jest.mocked(setCustomFolderShowUnreadBadge);

function chat(guid: string, displayName: string): Partial<InboxRow> {
  return { guid, displayName, participantCount: 1, isArchived: 0, participantNames: null };
}

function folderRow(overrides: Record<string, unknown> = {}) {
  return { id: 7, name: 'Family', sortOrder: 0, showUnreadBadge: 1, ...overrides };
}

const save = () => screen.getByRole('button', { name: 'Save folder membership' });
const conversation = (name: string) => screen.getByRole('checkbox', { name });

async function renderLoaded(members: string[] = ['c1']) {
  mockLoadFolders.mockResolvedValue({ status: 'current', value: [folderRow()] } as never);
  mockLoadMembership.mockResolvedValue({ status: 'current', value: members } as never);
  await renderWithTheme(<ConversationFolderMembershipScreen />);
  await screen.findByText('Family');
}

beforeEach(() => {
  mockFolderParam = '7';
  mockChats = {
    data: [chat('c1', 'Alice'), chat('c2', 'Bob'), chat('c3', 'Carol')],
    hasMore: false,
    loadMore: jest.fn(),
    isLoading: false,
    error: null,
  };
});

describe('folder membership screen', () => {
  it('loads the folder and checks its current members', async () => {
    await renderLoaded(['c1']);

    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(conversation('Alice').props.accessibilityState.checked).toBe(true);
    expect(conversation('Bob').props.accessibilityState.checked).toBe(false);
    expect(save().props.accessibilityState.disabled).toBe(true);
    expect(mockLoadMembership).toHaveBeenCalledWith(7, mockAccountLease);
  });

  it('enables Save only while the selection differs from what was loaded', async () => {
    await renderLoaded(['c1']);

    await fireEvent.press(conversation('Bob'));
    expect(screen.getByText('2 selected')).toBeTruthy();
    expect(save().props.accessibilityState.disabled).toBe(false);

    await fireEvent.press(conversation('Bob'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    expect(save().props.accessibilityState.disabled).toBe(true);
  });

  it('refuses a member past the per-folder limit and explains why', async () => {
    await renderLoaded(['c1', 'c2']);

    await fireEvent.press(conversation('Carol'));

    expect(conversation('Carol').props.accessibilityState.checked).toBe(false);
    expect(screen.getByText('2 selected')).toBeTruthy();
    expect(screen.getByRole('alert').props.children).toBe(
      'A folder cannot contain more than 2 conversations.',
    );
  });

  it('saves the exact selection and goes back', async () => {
    mockReplace.mockResolvedValue({ status: 'current', value: true } as never);
    await renderLoaded(['c1']);
    await fireEvent.press(conversation('Bob'));

    await fireEvent.press(save());

    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(mockReplace).toHaveBeenCalledWith(7, ['c1', 'c2'], mockAccountLease);
  });

  it('reports a folder deleted elsewhere instead of going back', async () => {
    mockReplace.mockResolvedValue({ status: 'current', value: false } as never);
    await renderLoaded(['c1']);
    await fireEvent.press(conversation('Bob'));

    await fireEvent.press(save());

    expect(await screen.findByText('This folder no longer exists.')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a failed save',
      new Error('db busy'),
      'Couldn’t save this folder. Your membership changes are still selected.',
    ],
    [
      'the total membership limit',
      new CustomFolderMembershipLimitError(),
      'Folders can hold 25,000 chats in total, so a backup can include them all. Remove some chats from this or another folder first.',
    ],
  ])('keeps the selection after %s and says what happened', async (_label, error, message) => {
    mockReplace.mockRejectedValue(error);
    await renderLoaded(['c1']);
    await fireEvent.press(conversation('Bob'));

    await fireEvent.press(save());

    expect((await screen.findByRole('alert')).props.children).toBe(message);
    expect(conversation('Bob').props.accessibilityState.checked).toBe(true);
    expect(save().props.accessibilityState.disabled).toBe(false);
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('changes the unread badge, and restores it when the change fails', async () => {
    mockSetBadge
      .mockResolvedValueOnce({ status: 'current', value: true } as never)
      .mockRejectedValueOnce(new Error('db busy'));
    await renderLoaded(['c1']);
    const badge = () => screen.getByRole('switch', { name: 'Show unread badge for this folder' });
    expect(badge().props.accessibilityState.checked).toBe(true);

    await fireEvent.press(badge());
    await waitFor(() => expect(badge().props.accessibilityState.checked).toBe(false));
    expect(mockSetBadge).toHaveBeenLastCalledWith(7, false, mockAccountLease);

    await fireEvent.press(badge());
    expect((await screen.findByRole('alert')).props.children).toBe(
      'Couldn’t change this folder’s unread badge.',
    );
    expect(badge().props.accessibilityState.checked).toBe(false);
  });

  it('says so when the folder cannot be loaded', async () => {
    mockLoadFolders.mockRejectedValue(new Error('db busy'));
    mockLoadMembership.mockResolvedValue({ status: 'current', value: [] } as never);
    await renderWithTheme(<ConversationFolderMembershipScreen />);

    expect(
      await screen.findByText('Couldn’t load this folder. Go back and try again.'),
    ).toBeTruthy();
    expect(save().props.accessibilityState.disabled).toBe(true);
  });

  it.each([
    ['a folder that no longer exists', '7', [folderRow({ id: 8 })]],
    ['an invalid folder id', 'not-a-number', [folderRow()]],
  ])('shows %s as missing', async (_label, param, folders) => {
    mockFolderParam = param;
    mockLoadFolders.mockResolvedValue({ status: 'current', value: folders } as never);
    mockLoadMembership.mockResolvedValue({ status: 'current', value: [] } as never);
    await renderWithTheme(<ConversationFolderMembershipScreen />);

    expect(await screen.findByText('This folder no longer exists.')).toBeTruthy();
    await act(async () => undefined);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
