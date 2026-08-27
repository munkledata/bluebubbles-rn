import React from 'react';
import { View } from 'react-native';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';
import { AppDialog } from '@ui/dialog/AppDialog';
import { useDialogStore } from '@ui/dialog/dialogStore';

const mockDispatch = jest.fn();
const mockUsePreventRemove = jest.fn();
let navigateWithoutPrompt: ((navigate: () => void) => void) | null = null;

jest.mock('expo-router', () => ({
  useNavigation: () => ({ dispatch: mockDispatch }),
}));
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (enabled: boolean, callback: (options: unknown) => void) =>
    mockUsePreventRemove(enabled, callback),
}));

// eslint-disable-next-line import/first
import { useUnsavedChangesGuard } from '@ui/hooks/useUnsavedChangesGuard';

function GuardProbe(): React.JSX.Element {
  ({ navigateWithoutPrompt } = useUnsavedChangesGuard({ enabled: true }));
  return <View />;
}

beforeEach(() => {
  jest.clearAllMocks();
  navigateWithoutPrompt = null;
  useDialogStore.setState({ current: null, queue: [] });
});

it('deduplicates removal attempts and replays the exact action only after explicit discard', async () => {
  await renderWithTheme(
    <>
      <GuardProbe />
      <AppDialog />
    </>,
  );
  const guardCall = mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
  expect(guardCall?.[0]).toBe(true);
  const action = { type: 'GO_BACK', source: 'scheduled-editor' };

  await act(async () => {
    guardCall?.[1]({ data: { action } });
    guardCall?.[1]({ data: { action } });
  });

  expect(screen.getByText('Discard changes?')).toBeTruthy();
  expect(useDialogStore.getState().queue).toHaveLength(0);
  expect(mockDispatch).not.toHaveBeenCalled();

  fireEvent.press(screen.getByText('Discard'));
  expect(mockDispatch).toHaveBeenCalledWith(action);
});

it('removes its open discard prompt when a successful operation navigates', async () => {
  await renderWithTheme(
    <>
      <GuardProbe />
      <AppDialog />
    </>,
  );
  const guardCall = mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
  const action = { type: 'GO_BACK', source: 'saved-editor' };

  await act(async () => {
    guardCall?.[1]({ data: { action } });
  });
  expect(screen.getByText('Discard changes?')).toBeTruthy();

  await act(async () => {
    navigateWithoutPrompt?.(() => guardCall?.[1]({ data: { action } }));
  });

  expect(screen.queryByText('Discard changes?')).toBeNull();
  expect(useDialogStore.getState().current).toBeNull();
  expect(mockDispatch).toHaveBeenCalledWith(action);
});
