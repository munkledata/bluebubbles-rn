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

  await act(async () => {
    fireEvent.press(screen.getByText('Discard'));
  });
  expect(mockDispatch).toHaveBeenCalledWith(action);
});

it('keeps the route mounted when asynchronous discard cleanup fails', async () => {
  function FailingGuardProbe(): React.JSX.Element {
    useUnsavedChangesGuard({ enabled: true, onDiscard: async () => false });
    return <View />;
  }
  await renderWithTheme(
    <>
      <FailingGuardProbe />
      <AppDialog />
    </>,
  );
  const guardCall = mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
  const action = { type: 'GO_BACK', source: 'failed-cleanup' };
  await act(async () => {
    guardCall?.[1]({ data: { action } });
  });

  await act(async () => {
    fireEvent.press(screen.getByText('Discard'));
  });

  expect(mockDispatch).not.toHaveBeenCalled();
});

it('starts follow-up work only after the confirmed route removal is dispatched', async () => {
  const order: string[] = [];
  mockDispatch.mockImplementation(() => order.push('dispatch'));
  function SequencedGuardProbe(): React.JSX.Element {
    useUnsavedChangesGuard({
      enabled: true,
      onDiscard: async () => {
        order.push('cleanup');
        return true;
      },
      onAfterDiscardNavigation: () => order.push('follow-up'),
    });
    return <View />;
  }
  await renderWithTheme(
    <>
      <SequencedGuardProbe />
      <AppDialog />
    </>,
  );
  const guardCall = mockUsePreventRemove.mock.calls[mockUsePreventRemove.mock.calls.length - 1];
  await act(async () => {
    guardCall?.[1]({ data: { action: { type: 'GO_BACK' } } });
  });
  await act(async () => {
    fireEvent.press(screen.getByText('Discard'));
  });

  expect(order).toEqual(['cleanup', 'dispatch', 'follow-up']);
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
