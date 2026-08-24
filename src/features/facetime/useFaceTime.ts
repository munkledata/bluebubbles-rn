import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { showDialog } from '@ui/dialog/dialogStore';
import * as WebBrowser from 'expo-web-browser';
import { faceTimeApi } from '@core/api';
import { isFaceTimeLink } from '@core/facetime';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { getChatParticipants } from '@db/repositories';
import { http, createNewChat } from '@/services';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { send } from '@/services/send';
import { isDevServer } from '@utils/isDev';
import { useFaceTimeStore } from '@state/faceTimeStore';

/**
 * Open the FaceTime link in CHROME specifically. Apple's FaceTime-web rejects Firefox (the
 * phone's default browser here) and other non-Chromium engines, so we open a Chrome custom
 * tab (expo-web-browser `browserPackage` → `Intent.setPackage`). Falls back to any other
 * custom-tab browser, then the system default, if Chrome isn't available.
 */
async function openFaceTimeLink(url: string, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  // Open in a CHROME custom tab. Apple's FaceTime-web rejects Firefox (the phone's default
  // browser here), and a custom tab runs in Chrome's OWN process — so its network context
  // resolves facetime.apple.com in the browser's trusted process. Fall back to
  // any available custom-tab browser (a Chromium one, not Firefox), then the default browser.
  try {
    await WebBrowser.openBrowserAsync(url, { browserPackage: 'com.android.chrome' });
    return;
  } catch (e) {
    if (!isCurrent()) return;
    logger.warn('[facetime] Chrome custom tab failed; trying a default custom tab', e);
  }
  if (!isCurrent()) return;
  try {
    await WebBrowser.openBrowserAsync(url);
    return;
  } catch (e) {
    if (!isCurrent()) return;
    logger.warn('[facetime] custom tab failed; falling back to the default browser', e);
  }
  if (!isCurrent()) return;
  await Linking.openURL(url);
}

export interface StartCallArgs {
  chatGuid: string;
  /** true = FaceTime video, false = audio-only (presentation hint only). */
  video: boolean;
}

/** Place a FaceTime call to explicit addresses (the dedicated dialer screen — no chat). */
export interface StartCallToArgs {
  addresses: string[];
  video: boolean;
}

function isCurrentCallGeneration(generation: number): boolean {
  return useFaceTimeStore.getState().generation === generation;
}

function isCurrentCallSession(generation: number, lease: RealtimeDeliveryLease): boolean {
  return isCurrentCallGeneration(generation) && lease.isCurrent();
}

/**
 * Start a FaceTime call — the LINK model.
 *
 * A headless Mac can't bridge THIS device into a native 1:1 call (that dial rings the
 * recipient but we can't join it, and it drops on answer). So the reliable model is a
 * FaceTime *link*: the Mac mints a link that INVITES the recipient(s) — it arrives in their
 * FaceTime as an invite, not just a bare URL — and we join the link in the phone's BROWSER
 * (the embedded WebView is intentionally disabled). In dev (no server) a stub link is shown in
 * the safe browser-handoff overlay.
 */
export function useFaceTime(): {
  startCall: (args: StartCallArgs) => Promise<void>;
  startCallTo: (args: StartCallToArgs) => Promise<void>;
} {
  const openIfCurrent = useFaceTimeStore((s) => s.openIfCurrent);
  // These callbacks belong to the route/header instance that created them. Capturing here prevents
  // a retained account-A callback from minting a fresh account-B lease when it is pressed later.
  const [callScope] = useState(() => ({
    generation: useFaceTimeStore.getState().generation,
    accountLease: captureRealtimeDeliveryLease(),
  }));

  const startCall = useCallback(
    async ({ chatGuid, video }: StartCallArgs): Promise<void> => {
      const { generation, accountLease } = callScope;
      const isCurrent = (): boolean => isCurrentCallSession(generation, accountLease);
      try {
        if (!isCurrent()) return;
        if (isDevServer()) {
          const stub = `https://facetime.apple.com/join#v=1&p=dev&k=${Date.now()}`;
          const { devSendFake } = await import('@features/conversations/devSeed');
          if (!isCurrent()) return;
          await devSendFake(chatGuid, stub, undefined, accountLease);
          if (!isCurrent()) return;
          openIfCurrent({ link: stub, chatGuid, video }, generation);
          return;
        }
        // Invite the chat's participant(s) into the link (it shows up in their FaceTime),
        // drop the link into the thread as a tappable backup, then join it in the browser.
        const addresses = (await getChatParticipants(getDatabase(), chatGuid))
          .map((p) => p.address)
          .filter((a) => a.length > 0);
        if (!isCurrent()) return;
        const link = await faceTimeApi.createFaceTimeLink(http, addresses);
        if (!isCurrent()) return;
        if (!isFaceTimeLink(link)) throw new Error('server returned no FaceTime link');
        await send({ chatGuid, text: link }, accountLease);
        if (!isCurrent()) return;
        await openFaceTimeLink(link, isCurrent);
      } catch (err) {
        if (!isCurrent()) return;
        logger.warn('[facetime] failed to start call', err);
        showDialog('FaceTime', 'Couldn’t start the call. Make sure your server is connected.');
      }
    },
    [callScope, openIfCurrent],
  );

  const startCallTo = useCallback(
    async ({ addresses, video }: StartCallToArgs): Promise<void> => {
      const { generation, accountLease } = callScope;
      const isCurrent = (): boolean => isCurrentCallSession(generation, accountLease);
      if (!isCurrent()) return;
      const clean = addresses.map((a) => a.trim()).filter((a) => a.length > 0);
      if (clean.length === 0) {
        showDialog('FaceTime', 'Enter a phone number or email to call.');
        return;
      }
      try {
        if (!isCurrent()) return;
        if (isDevServer()) {
          openIfCurrent(
            {
              link: `https://facetime.apple.com/join#v=1&p=dev&k=${Date.now()}`,
              chatGuid: '',
              video,
            },
            generation,
          );
          return;
        }
        // Invite the recipient(s) into the link (arrives in their FaceTime), text it as a
        // tappable backup, then join it in the phone's browser.
        const link = await faceTimeApi.createFaceTimeLink(http, clean);
        if (!isCurrent()) return;
        if (!isFaceTimeLink(link)) throw new Error('server returned no FaceTime link');
        try {
          await createNewChat(clean, link, 'iMessage', accountLease);
        } catch (e) {
          if (isCurrent()) {
            logger.warn('[facetime] could not text the FaceTime link to the recipient(s)', e);
          }
        }
        if (!isCurrent()) return;
        await openFaceTimeLink(link, isCurrent);
      } catch (err) {
        if (!isCurrent()) return;
        logger.warn('[facetime] start failed', err);
        showDialog('FaceTime', 'Couldn’t start the call. Make sure your server is connected.');
      }
    },
    [callScope, openIfCurrent],
  );

  return { startCall, startCallTo };
}
