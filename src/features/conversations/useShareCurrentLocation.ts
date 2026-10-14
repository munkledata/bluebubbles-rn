import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { AppState, Linking } from 'react-native';
import { logger } from '@core/secure';
import {
  prepareCurrentLocationPermission,
  type CurrentLocationPermissionOutcome,
} from '@/services/location/currentLocation';
import { getExpoLocationAdapter } from '@/services/location/expoLocationAdapter';
import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { captureSessionRcsCapabilityLease } from '@/services/send/rcsAttemptCapability';
import { acquireAndSendCurrentLocation, type ShareCurrentLocationResult } from '@/services/send';
import { useSessionStore } from '@state/sessionStore';
import { presentSendIssue } from '@ui/conversations/sendNotices';
import { showConfirm, showDialog, useDialogStore, type DialogButton } from '@ui/dialog/dialogStore';

/**
 * Send Current Location for the open chat: one confirmed, foreground-only location send.
 *
 * The flow asks before reading anything, prompts for permission when needed, reads one current
 * location and queues it. It ends (closing its dialogs) when the screen loses focus, the app leaves
 * the foreground outside the permission prompt, the account changes, or the server stops offering
 * location sharing. Only one flow runs at a time.
 */
export function useShareCurrentLocation(
  guid: string,
  accountLease: RealtimeDeliveryLease,
  currentLocationAvailable: boolean,
): () => void {
  const locationScreenRef = useRef<object | null>(null);
  const locationFlowRef = useRef<{ cancel(): void } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!currentLocationAvailable || !accountLease.isCurrent()) return;
      locationScreenRef.current = { guid };
      return () => {
        locationScreenRef.current = null;
        locationFlowRef.current?.cancel();
      };
    }, [accountLease, currentLocationAvailable, guid]),
  );
  const onShareCurrentLocation = useCallback((): void => {
    const screen = locationScreenRef.current;
    const capability = captureSessionRcsCapabilityLease();
    if (
      locationFlowRef.current ||
      !screen ||
      !currentLocationAvailable ||
      !accountLease.isCurrent() ||
      AppState.currentState !== 'active' ||
      capability?.isCurrent() !== true ||
      capability.serverInfo?.supports_imessage_location !== true
    )
      return;

    const controller = new AbortController();
    let alive = true;
    let permissionOnly = false;
    let pendingFeedback: (() => void) | null = null;
    let dialogId: number | null = null;
    let dialogToken: object | null = null;
    let cancelAcquisition: (() => void) | null = null;
    const cleanups: Array<() => void> = [];
    const current = (): boolean =>
      alive &&
      locationScreenRef.current === screen &&
      accountLease.isCurrent() &&
      capability.isCurrent();
    const foreground = (): boolean => current() && AppState.currentState === 'active';
    const finish = (): void => {
      if (!alive) return;
      alive = false;
      controller.abort();
      cancelAcquisition?.();
      pendingFeedback = null;
      dialogToken = null;
      if (dialogId !== null) useDialogStore.getState().dismissById(dialogId);
      for (const cleanup of cleanups) cleanup();
      if (locationFlowRef.current === flow) locationFlowRef.current = null;
    };
    const flow = { cancel: finish };
    locationFlowRef.current = flow;
    const registerCleanup = (cleanup: () => void): void => {
      if (alive) cleanups.push(cleanup);
      else cleanup();
    };
    // One-shot callbacks remain owned even though AppDialog dismisses before invoking them.
    const guardButton =
      (action: () => void, token: object): (() => void) =>
      () => {
        if (dialogToken !== token || !foreground()) return;
        dialogToken = null;
        dialogId = null;
        action();
      };
    const explain = (title: string, message: string, buttons?: DialogButton[]): void => {
      if (!foreground()) return;
      const token = {};
      dialogToken = token;
      dialogId = showDialog(
        title,
        message,
        (buttons ?? [{ text: 'OK' }]).map((button) => ({
          ...button,
          onPress: guardButton(button.onPress ?? finish, token),
        })),
      );
    };
    const confirm = (action: () => void, afterPermission = false): void => {
      if (!foreground()) return;
      const token = {};
      dialogToken = token;
      dialogId = showConfirm({
        title: 'Send Current Location?',
        message: afterPermission
          ? 'Location access is allowed. Tap Send Location to get one current location and send it to this conversation. Nothing has been sent yet.'
          : 'Gator will request one current location and send it to this conversation through your server. It does not track your location in the background.',
        confirmText: 'Send Location',
        onConfirm: guardButton(action, token),
        onCancel: guardButton(finish, token),
      });
    };
    const openSettings = (): void => {
      if (!foreground()) return;
      finish();
      void Linking.openSettings().catch(() => undefined);
    };
    const report = (
      result:
        | Exclude<CurrentLocationPermissionOutcome, { status: 'granted' }>
        | ShareCurrentLocationResult,
    ): void => {
      if (!foreground()) return;
      if (result.status === 'queued' || result.status === 'cancelled') {
        finish();
        return;
      }
      if (result.status === 'unavailable') {
        explain(
          'Location Sharing Unavailable',
          'The connected server no longer offers current-location sharing.',
        );
      } else if (result.status === 'services-off') {
        explain('Location Services Are Off', 'Turn on location services, then try again.', [
          { text: 'Not Now', style: 'cancel' },
          { text: 'Open Settings', onPress: openSettings },
        ]);
      } else if (result.status === 'denied') {
        explain(
          'Location Permission Needed',
          'Gator needs foreground location access to send your current location. No location is read in the background.',
          [
            { text: 'Not Now', style: 'cancel' },
            result.canAskAgain
              ? { text: 'Try Again', onPress: prepare }
              : { text: 'Open Settings', onPress: openSettings },
          ],
        );
      } else {
        explain(
          'Couldn’t Get Location',
          result.status === 'timeout'
            ? 'Gator did not get a current location within 15 seconds. Nothing was sent.'
            : 'Gator could not read a current location. Nothing was sent.',
        );
      }
    };
    const fail = (error: unknown): void => {
      if (!foreground()) return;
      logger.warn('[chat] current-location send failed', error);
      explain('Couldn’t Send Location', 'Your location was not queued. Please try again.');
    };
    const sendLocation = (): void => {
      if (!foreground()) return;
      void acquireAndSendCurrentLocation(guid, {
        foregroundLifecycle: {
          isActive: foreground,
          subscribeToInactive: (cancel) => {
            cancelAcquisition = cancel;
            if (!foreground()) cancel();
            return () => {
              if (cancelAcquisition === cancel) cancelAcquisition = null;
            };
          },
        },
        accountLease,
        reportIssue: presentSendIssue,
      })
        .then(report)
        .catch(fail);
    };
    const prepare = (): void => {
      if (!foreground()) return;
      void (async () => {
        const result = await prepareCurrentLocationPermission(getExpoLocationAdapter(), {
          signal: controller.signal,
          isCurrent: () => current() && (permissionOnly || AppState.currentState === 'active'),
          beforePrompt: () => {
            if (!foreground()) return false;
            permissionOnly = true;
            return true;
          },
        });
        if (!current()) return;
        const present = (): void => {
          if (!foreground()) return;
          permissionOnly = false;
          if (result.status === 'granted') {
            if (result.prompted) confirm(sendLocation, true);
            else sendLocation();
          } else report(result);
        };
        if (foreground()) present();
        else pendingFeedback = present;
      })().catch(fail);
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (!current()) {
        finish();
        return;
      }
      if (state !== 'active') {
        // Android's permission Activity also pauses us. This phase can only prepare feedback;
        // even a granted late result must ask for a new send intent on a current foreground screen.
        if (!permissionOnly) finish();
      } else {
        const present = pendingFeedback;
        pendingFeedback = null;
        present?.();
      }
    });
    registerCleanup(() => appStateSubscription.remove());
    registerCleanup(subscribeRealtimeGenerationInvalidation(accountLease.generation, finish));
    registerCleanup(
      useSessionStore.subscribe(() => {
        if (!current()) finish();
      }),
    );
    if (!foreground()) finish();
    else confirm(prepare);
  }, [accountLease, currentLocationAvailable, guid]);
  return onShareCurrentLocation;
}
