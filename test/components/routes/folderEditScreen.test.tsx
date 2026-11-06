/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { CustomFolderListRow } from '@db/repositories';
import type { DialogButton } from '@ui/dialog/dialogStore';

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockDismissTo = jest.fn();
const mockShowDialog = jest.fn();
const mockIsCurrent = jest.fn(() => true);
const mockAccountLease = { generation: 41, isCurrent: mockIsCurrent };
let mockParams: { folderId?: string | string[] } = {};
let mockInvalidate: (() => void) | null = null;
let mockGuardOptions: { enabled: boolean; onDiscard?: () => void } | null = null;

jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  return {
    useRouter: () => ({ back: mockBack, replace: mockReplace, dismissTo: mockDismissTo }),
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (callback: () => void | (() => void)) =>
      ReactLib.useEffect(callback, [callback]),
  };
});
jest.mock('@/services/customFolderCommands', () => ({
  createCustomFolder: jest.fn(),
  deleteCustomFolder: jest.fn(),
  loadCustomFolders: jest.fn(),
  renameCustomFolder: jest.fn(),
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockAccountLease,
  subscribeRealtimeGenerationInvalidation: (_generation: number, invalidate: () => void) => {
    mockInvalidate = invalidate;
    return () => {
      mockInvalidate = null;
    };
  },
}));
jest.mock('@ui/dialog/dialogStore', () => ({
  showDialog: (...args: unknown[]) => mockShowDialog(...args),
}));
jest.mock('@ui/hooks/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: (options: { enabled: boolean; onDiscard?: () => void }) => {
    mockGuardOptions = options;
    return { navigateWithoutPrompt: (navigate: () => void) => navigate() };
  },
}));
jest.mock('@ui', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable, Text, View } = require('react-native');
  return {
    TextField: jest.requireActual('@ui/primitives/TextField').TextField,
    useTheme: () => ({
      color: {
        tint: '#0088ff',
        label: '#111111',
        secondaryLabel: '#555555',
        tertiaryLabel: '#888888',
        destructive: '#cc0000',
      },
    }),
    Screen: ({ children }: { children?: React.ReactNode }) =>
      ReactLib.createElement(View, null, children),
    ScreenHeader: ({
      title,
      right,
      onBack,
    }: {
      title: string;
      right?: React.ReactNode;
      onBack?: () => void;
    }) =>
      ReactLib.createElement(
        View,
        null,
        ReactLib.createElement(Text, null, title),
        ReactLib.createElement(
          Pressable,
          { accessibilityRole: 'button', accessibilityLabel: 'Back', onPress: onBack },
          ReactLib.createElement(Text, null, 'Back'),
        ),
        right,
      ),
  };
});

import ConversationFolderEditScreen from '../../../app/(app)/folders/edit';
import {
  createCustomFolder,
  deleteCustomFolder,
  loadCustomFolders,
  renameCustomFolder,
} from '@/services/customFolderCommands';

const FOLDER: CustomFolderListRow = {
  id: 7,
  name: 'Alpha',
  sortOrder: 0,
  chatCount: 1,
  showUnreadBadge: 1,
};
const committed = <T,>(value: T) => ({ status: 'committed' as const, value });
const STALE = { status: 'stale' as const };

async function renderScreen(params: typeof mockParams = {}) {
  mockParams = params;
  return renderWithTheme(<ConversationFolderEditScreen />);
}
async function typeName(name: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('Folder name'), name);
  });
}
const saveButton = () => screen.getByRole('button', { name: 'Save folder' });
async function pressSave(): Promise<void> {
  await act(async () => {
    fireEvent.press(saveButton());
  });
}
async function loadedFolder(): Promise<void> {
  await renderScreen({ folderId: '7' });
  await waitFor(() => expect(screen.getByLabelText('Folder name').props.value).toBe('Alpha'));
}
async function openDeleteConfirmation(): Promise<DialogButton[]> {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Delete Alpha' }));
  });
  const calls = mockShowDialog.mock.calls as [string, string, DialogButton[]][];
  const [title, message, buttons] = calls[calls.length - 1]!;
  expect(title).toBe('Delete Folder');
  expect(message).toContain('“Alpha”');
  return buttons;
}
async function pressDialog(buttons: DialogButton[], text: string): Promise<void> {
  await act(async () => {
    buttons.find((button) => button.text === text)?.onPress?.();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsCurrent.mockReturnValue(true);
  mockParams = {};
  mockInvalidate = null;
  mockGuardOptions = null;
  jest.mocked(loadCustomFolders).mockResolvedValue(committed([FOLDER]));
});

describe('ConversationFolderEditScreen create', () => {
  it('keeps Save disabled for a blank name, ignores a stale create, and replaces the route after a committed one', async () => {
    const create = jest.mocked(createCustomFolder);
    create.mockResolvedValueOnce(STALE);
    create.mockResolvedValueOnce(committed({ id: 9, name: 'Work', sortOrder: 1, chatCount: 0 }));
    await renderScreen();
    expect(screen.getByText('New Folder')).toBeTruthy();
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
    await typeName('   ');
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
    await pressSave();
    expect(create).not.toHaveBeenCalled();

    await typeName('Work');
    expect(saveButton().props.accessibilityState.disabled).toBe(false);
    await pressSave();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(mockReplace).not.toHaveBeenCalled();
    await waitFor(() => expect(saveButton().props.accessibilityState.busy).toBe(false));

    await pressSave();
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/folders/9'));
    expect(create).toHaveBeenLastCalledWith('Work', mockAccountLease);
  });

  it('saves from the keyboard’s done key and leaves through the header back button', async () => {
    jest
      .mocked(createCustomFolder)
      .mockResolvedValue(committed({ id: 3, name: 'Home', sortOrder: 0, chatCount: 0 }));
    await renderScreen();
    await typeName('Home');
    await act(async () => {
      fireEvent(screen.getByLabelText('Folder name'), 'submitEditing');
    });
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/folders/3'));

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('stops saving once the owner discards the draft, and goes blank when the account is invalidated', async () => {
    await renderScreen();
    expect(mockGuardOptions?.enabled).toBe(false);
    await typeName('Draft');
    expect(mockGuardOptions?.enabled).toBe(true);
    await act(async () => {
      mockGuardOptions?.onDiscard?.();
    });
    await pressSave();
    expect(createCustomFolder).not.toHaveBeenCalled();

    await act(async () => {
      mockInvalidate?.();
    });
    expect(screen.queryByLabelText('Folder name')).toBeNull();
    expect(screen.queryByText('New Folder')).toBeNull();
  });
});

describe('ConversationFolderEditScreen rename', () => {
  it('loads the folder, enables Save only once the name changes, and goes back after a committed rename', async () => {
    jest.mocked(renameCustomFolder).mockResolvedValue(committed(true));
    await loadedFolder();
    expect(screen.getByText('Manage Folder')).toBeTruthy();
    expect(loadCustomFolders).toHaveBeenCalledWith(mockAccountLease);
    expect(saveButton().props.accessibilityState.disabled).toBe(true);

    await typeName('Alpha Team');
    expect(saveButton().props.accessibilityState.disabled).toBe(false);
    await pressSave();
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
    expect(renameCustomFolder).toHaveBeenCalledWith(7, 'Alpha Team', mockAccountLease);
  });

  it('reports a folder that vanished before the rename landed', async () => {
    jest.mocked(renameCustomFolder).mockResolvedValue(committed(false));
    await loadedFolder();
    await typeName('Gone');
    await pressSave();
    expect(await screen.findByText('This folder no longer exists.')).toBeTruthy();
    expect(screen.queryByLabelText('Folder name')).toBeNull();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('shows a missing folder instead of an editable name', async () => {
    jest.mocked(loadCustomFolders).mockResolvedValueOnce(committed([]));
    await renderScreen({ folderId: '7' });
    expect(await screen.findByText('This folder no longer exists.')).toBeTruthy();
    expect(screen.queryByLabelText('Folder name')).toBeNull();
  });

  it('shows a failed load in the owner’s words, never the internal error', async () => {
    jest.mocked(loadCustomFolders).mockRejectedValueOnce(new Error('db closed'));
    await renderScreen({ folderId: '7' });
    expect(
      await screen.findByText('Couldn’t load this folder. Go back and try again.'),
    ).toBeTruthy();
    expect(screen.queryByText(/db closed/)).toBeNull();
    expect(screen.queryByLabelText('Folder name')).toBeNull();
  });

  it('leaves the name empty and Save disabled after a stale load result', async () => {
    jest.mocked(loadCustomFolders).mockResolvedValueOnce(STALE);
    await renderScreen({ folderId: '7' });
    await waitFor(() => expect(screen.getByLabelText('Folder name').props.value).toBe(''));
    expect(saveButton().props.accessibilityState.disabled).toBe(true);
  });

  it('treats a malformed folder id as a missing folder without reading the database', async () => {
    await renderScreen({ folderId: ['abc'] });
    expect(screen.getByText('This folder no longer exists.')).toBeTruthy();
    expect(screen.getByText('Manage Folder')).toBeTruthy();
    expect(loadCustomFolders).not.toHaveBeenCalled();
  });
});

describe('ConversationFolderEditScreen delete', () => {
  it('asks first, releases the confirmation on Cancel, and dismisses to the list after a committed delete', async () => {
    jest.mocked(deleteCustomFolder).mockResolvedValue(committed(true));
    await loadedFolder();
    const buttons = await openDeleteConfirmation();
    await pressDialog(buttons, 'Cancel');
    expect(deleteCustomFolder).not.toHaveBeenCalled();

    const again = await openDeleteConfirmation();
    expect(mockShowDialog).toHaveBeenCalledTimes(2);
    await pressDialog(again, 'Delete');
    await waitFor(() => expect(mockDismissTo).toHaveBeenCalledWith('/folders'));
    expect(deleteCustomFolder).toHaveBeenCalledWith(7, mockAccountLease);
  });

  it('reports a delete that found no folder and keeps the screen', async () => {
    jest.mocked(deleteCustomFolder).mockResolvedValueOnce(committed(false));
    await loadedFolder();
    await pressDialog(await openDeleteConfirmation(), 'Delete');
    expect(await screen.findByText('This folder no longer exists.')).toBeTruthy();
    expect(mockDismissTo).not.toHaveBeenCalled();
  });

  it('explains a failed delete in the owner’s words and leaves the name editable', async () => {
    jest.mocked(deleteCustomFolder).mockRejectedValueOnce(new Error('locked'));
    await loadedFolder();
    await pressDialog(await openDeleteConfirmation(), 'Delete');
    expect(
      await screen.findByText('Couldn’t delete the folder. Nothing else was changed.'),
    ).toBeTruthy();
    expect(screen.queryByText(/locked/)).toBeNull();
    expect(screen.getByLabelText('Folder name').props.value).toBe('Alpha');
    expect(mockDismissTo).not.toHaveBeenCalled();
  });
});
