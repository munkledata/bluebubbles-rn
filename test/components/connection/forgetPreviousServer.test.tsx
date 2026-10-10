/**
 * "Forget on this phone only": the confirmation must name the old server and warn that it may still
 * list this phone before the local-only forget runs, and a cleanup that still fails must be reported.
 */
jest.mock('@ui/dialog/dialogStore', () => ({ showDialog: jest.fn() }));

// eslint-disable-next-line import/first
import React from 'react';
// eslint-disable-next-line import/first
import { confirmForgetPreviousServer, ForgetPreviousServerAction } from '@ui/connection';
// eslint-disable-next-line import/first
import { showDialog, type DialogButton } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockShowDialog = showDialog as jest.Mock;

function makeDeps(overrides: Partial<Parameters<typeof confirmForgetPreviousServer>[0]> = {}) {
  return {
    previousServerOrigin: jest.fn(async (): Promise<string | null> => 'https://gone.example'),
    forgetOnThisPhoneOnly: jest.fn(async (): Promise<void> => undefined),
    failureMessage: jest.fn((_error: unknown) => 'still blocked'),
    ...overrides,
  };
}

function dialogButton(text: string): DialogButton {
  const buttons = mockShowDialog.mock.calls[0]?.[2] as DialogButton[];
  const button = buttons.find((candidate) => candidate.text === text);
  if (!button) throw new Error(`no dialog button ${text}`);
  return button;
}

beforeEach(() => {
  mockShowDialog.mockClear();
});

describe('forget a previous server on this phone only', () => {
  it('names the server and warns it may still list this phone before forgetting', async () => {
    const deps = makeDeps();

    await confirmForgetPreviousServer(deps);

    const [title, message] = mockShowDialog.mock.calls[0] as [string, string];
    expect(title).toBe('Forget on this phone only?');
    expect(message).toContain('https://gone.example');
    expect(message).toContain('may still list this phone');
    expect(deps.forgetOnThisPhoneOnly).not.toHaveBeenCalled();

    dialogButton('Forget on this phone').onPress?.();
    expect(deps.forgetOnThisPhoneOnly).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the user cancels', async () => {
    const deps = makeDeps();

    await confirmForgetPreviousServer(deps);
    dialogButton('Cancel').onPress?.();

    expect(deps.forgetOnThisPhoneOnly).not.toHaveBeenCalled();
  });

  it('reports a cleanup that still fails', async () => {
    const failure = new Error('blocked');
    const deps = makeDeps({
      forgetOnThisPhoneOnly: jest.fn(async () => {
        throw failure;
      }),
    });

    await confirmForgetPreviousServer(deps);
    await act(async () => {
      dialogButton('Forget on this phone').onPress?.();
    });

    expect(deps.failureMessage).toHaveBeenCalledWith(failure);
    expect(mockShowDialog).toHaveBeenLastCalledWith('Could not finish', 'still blocked');
  });

  it('falls back to a generic name when the server address cannot be read', async () => {
    await confirmForgetPreviousServer(
      makeDeps({
        previousServerOrigin: jest.fn(async () => {
          throw new Error('SecureStore unavailable');
        }),
      }),
    );

    expect(mockShowDialog.mock.calls[0]?.[1]).toContain('the previous server');
  });

  it('opens the confirmation from an accessible button', async () => {
    await renderWithTheme(<ForgetPreviousServerAction {...makeDeps()} />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Forget on this phone only' }));
    });

    expect(mockShowDialog).toHaveBeenCalledTimes(1);
  });
});
