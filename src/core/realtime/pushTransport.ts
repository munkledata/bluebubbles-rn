/** Delivers raw realtime events (push / socket) into the app's event pipeline. */
export type EventDispatch = (eventName: string, rawData: unknown) => Promise<void> | void;

export interface PushTransport {
  start(dispatch: EventDispatch): Promise<void> | void;
  stop(): void;
}

/**
 * DEV/test transport: inject events as if a push arrived, with no Firebase or
 * server. Drives the exact same dispatch the real transports use, so the dev
 * "Inject message" button exercises the full receive → DB → notification path.
 */
export class DevPushTransport implements PushTransport {
  private dispatch: EventDispatch | null = null;
  start(dispatch: EventDispatch): void {
    this.dispatch = dispatch;
  }
  stop(): void {
    this.dispatch = null;
  }
  async inject(eventName: string, rawData: unknown): Promise<void> {
    await this.dispatch?.(eventName, rawData);
  }
}

/**
 * FCM is ENABLED. The live transport is `src/services/notifications/fcmMessaging.ts`,
 * which imports `@react-native-firebase/messaging` directly, registers the killed-app
 * background handler at module top level, and parses the server envelope via
 * `fcmPayload.ts`. This flag gates STARTING the foreground handler at boot
 * (app/_layout.tsx); flip it to `false` to disable push without uninstalling firebase.
 */
export const FCM_ENABLED = true;
