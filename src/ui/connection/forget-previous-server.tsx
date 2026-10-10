import React from 'react';
import { showDialog } from '../dialog/dialogStore';
import { Button } from '../primitives';

export interface ForgetPreviousServerDeps {
  /** The server a retained, unrevoked credential belongs to (confirmation text only). */
  readonly previousServerOrigin: () => Promise<string | null>;
  /** The full Disconnect wipe without the server revoke step; rejects if cleanup stays incomplete. */
  readonly forgetOnThisPhoneOnly: () => Promise<void>;
  /** Maps a cleanup failure to the message shown to the user. */
  readonly failureMessage: (error: unknown) => string;
}

/**
 * Ask before forgetting a previous server's credential on this phone only. Gator could not get the
 * server to confirm it revoked this phone's access, so the user must hear that the old server may
 * keep listing this phone until it is removed there.
 */
export async function confirmForgetPreviousServer(deps: ForgetPreviousServerDeps): Promise<void> {
  const origin = await deps.previousServerOrigin().catch(() => null);
  showDialog(
    'Forget on this phone only?',
    `Gator couldn't reach ${origin ?? 'the previous server'} to remove this phone's access.\n\n` +
      'If you continue, Gator deletes that access from this phone so you can connect again. ' +
      'The old server may still list this phone as a device until you remove it there.',
    [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget on this phone',
        style: 'destructive',
        onPress: () => {
          void deps.forgetOnThisPhoneOnly().catch((error: unknown) => {
            showDialog('Could not finish', deps.failureMessage(error));
          });
        },
      },
    ],
  );
}

/** The escape hatch under a connection error caused by an unconfirmed credential revocation. */
export function ForgetPreviousServerAction(props: ForgetPreviousServerDeps): React.JSX.Element {
  return (
    <Button
      title="Forget on this phone only"
      variant="plain"
      onPress={() => {
        void confirmForgetPreviousServer(props);
      }}
    />
  );
}
