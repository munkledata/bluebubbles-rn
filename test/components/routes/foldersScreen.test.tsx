import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { CustomFolderSummaryRow } from '@db/repositories';
import type { CustomFolderSummariesState } from '@features/conversations/useCustomFolderSummaries';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockRetryFolders = jest.fn();
const mockReorderCustomFolders = jest.fn();
const mockShowDialog = jest.fn();
const mockUnsubscribe = jest.fn();
const mockIsCurrent = jest.fn(() => true);
const mockAccountLease = { generation: 41, isCurrent: mockIsCurrent };
let mockFolderState: CustomFolderSummariesState;
const mockUseCustomFolderSummaries = jest.fn(
  (_lease: unknown, _enabled: boolean) => mockFolderState,
);

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  return {
    useRouter: () => ({ back: mockBack, push: mockPush }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: (callback: () => void | (() => void)) =>
      ReactLib.useEffect(callback, [callback]),
  };
});
jest.mock('@features/conversations/useCustomFolderSummaries', () => ({
  useCustomFolderSummaries: (lease: unknown, enabled: boolean) =>
    mockUseCustomFolderSummaries(lease, enabled),
}));
jest.mock('@/services/customFolderCommands', () => ({
  createCustomFolder: jest.fn(),
  deleteCustomFolder: jest.fn(),
  loadCustomFolders: jest.fn(),
  reorderCustomFolders: (...args: unknown[]) => mockReorderCustomFolders(...args),
  renameCustomFolder: jest.fn(),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockAccountLease,
  subscribeRealtimeGenerationInvalidation: () => mockUnsubscribe,
}));
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: mockShowDialog }));
jest.mock('@ui/hooks/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => ({ navigateWithoutPrompt: (navigate: () => void) => navigate() }),
}));
jest.mock('@ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text, View } = require('react-native');
  return {
    TextField: jest.requireActual('@ui/primitives/TextField').TextField,
    readableTextOn: () => '#ffffff',
    useTheme: () => ({
      color: {
        tint: '#0088ff',
        label: '#111111',
        secondaryLabel: '#555555',
        tertiaryLabel: '#888888',
        secondaryBackground: '#eeeeee',
        separator: '#cccccc',
        destructive: '#cc0000',
      },
    }),
    Screen: ({ children }: { children: React.ReactNode }) =>
      ReactLib.createElement(View, null, children),
    ScreenHeader: ({ title, right }: { title: string; right?: React.ReactNode }) =>
      ReactLib.createElement(View, null, ReactLib.createElement(Text, null, title), right),
  };
});

// eslint-disable-next-line import/first
import ConversationFoldersScreen from '../../../app/(app)/folders';
// eslint-disable-next-line import/first
import ConversationFolderEditScreen from '../../../app/(app)/folders/edit';
// eslint-disable-next-line import/first
import { CustomFolderInputError } from '@core/customFolderInputError';
// eslint-disable-next-line import/first
import { createCustomFolder } from '@/services/customFolderCommands';

const INITIAL_ROWS: CustomFolderSummaryRow[] = [
  {
    id: 1,
    name: 'Alpha',
    sortOrder: 0,
    chatCount: 1,
    showUnreadBadge: 1,
    unreadChatCount: 1,
  },
  {
    id: 2,
    name: 'Beta',
    sortOrder: 1,
    chatCount: 2,
    showUnreadBadge: 0,
    unreadChatCount: 0,
  },
];

function displayedFolderNames(): unknown[] {
  return screen.getAllByText(/^(Alpha|Beta)$/).map((node) => node.props.children);
}

describe('ConversationFoldersScreen reorder handoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCurrent.mockReturnValue(true);
    mockFolderState = {
      data: INITIAL_ROWS,
      isLoading: false,
      error: null,
      retry: mockRetryFolders,
    };
    mockUseCustomFolderSummaries.mockImplementation(() => mockFolderState);
    mockReorderCustomFolders.mockResolvedValue({ status: 'committed', value: true });
  });

  it('keeps a successful optimistic order until a new authoritative row array arrives', async () => {
    const view = await renderWithTheme(<ConversationFoldersScreen />);
    await waitFor(() =>
      expect(mockUseCustomFolderSummaries).toHaveBeenLastCalledWith(mockAccountLease, true),
    );
    expect(displayedFolderNames()).toEqual(['Alpha', 'Beta']);

    await fireEvent.press(screen.getByRole('button', { name: 'Move Alpha later' }));
    await waitFor(() => expect(mockRetryFolders).toHaveBeenCalledTimes(1));

    expect(mockReorderCustomFolders).toHaveBeenCalledWith([2, 1], mockAccountLease);
    expect(displayedFolderNames()).toEqual(['Beta', 'Alpha']);

    mockFolderState = {
      ...mockFolderState,
      data: INITIAL_ROWS.map((row) => ({ ...row })),
    };
    await view.rerender(<ConversationFoldersScreen />);

    expect(displayedFolderNames()).toEqual(['Alpha', 'Beta']);
  });
});

describe('ConversationFolderEditScreen accessibility', () => {
  it('gives the folder-name input a direct accessible label', async () => {
    mockIsCurrent.mockReturnValue(true);
    await renderWithTheme(<ConversationFolderEditScreen />);

    const input = screen.getByLabelText('Folder name');
    expect(input.props.accessibilityLabel).toBe('Folder name');
    expect(input.props.accessibilityLabelledBy).toBeUndefined();
  });
});

describe('ConversationFolderEditScreen save failures', () => {
  it('shows a name problem in the owner’s words but never a raw internal error', async () => {
    mockIsCurrent.mockReturnValue(true);
    const create = jest.mocked(createCustomFolder);
    create.mockRejectedValueOnce(new TypeError('Cannot read properties of undefined (reading id)'));
    await renderWithTheme(<ConversationFolderEditScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Folder name'), 'Work');
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
    });
    expect(
      await screen.findByText('Couldn’t save the folder. Your changes are still here.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Cannot read properties/)).toBeNull();

    create.mockRejectedValueOnce(
      new CustomFolderInputError('A folder with that name already exists.'),
    );
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
    });
    expect(await screen.findByText('A folder with that name already exists.')).toBeTruthy();
  });
});
