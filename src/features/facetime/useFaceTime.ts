import { useCallback } from 'react';
import { Alert, Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { faceTimeApi } from '@core/api';
import { isFaceTimeLink } from '@core/facetime';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { getChatParticipants } from '@db/repositories';
import { http, createNewChat } from '@/services';
import { send } from '@/services/send';
import { isDevServer } from '@utils/isDev';
import { useFaceTimeStore } from '@state/faceTimeStore';

/**
 * Open the FaceTime link in CHROME specifically. Apple's FaceTime-web rejects Firefox (the
 * phone's default browser here) and other non-Chromium engines, so we open a Chrome custom
 * tab (expo-web-browser `browserPackage` → `Intent.setPackage`). Falls back to any other
 * custom-tab browser, then the system default, if Chrome isn't available.
 */
async function openFaceTimeLink(url: string): Promise<void> {
  // Open in a CHROME custom tab. Apple's FaceTime-web rejects Firefox (the phone's default
  // browser here), and a custom tab runs in Chrome's OWN process — so its network context
  // resolves facetime.apple.com even where the app's embedded WebView couldn't. Fall back to
  // any available custom-tab browser (a Chromium one, not Firefox), then the default browser.
  try {
    await WebBrowser.openBrowserAsync(url, { browserPackage: 'com.android.chrome' });
    return;
  } catch (e) {
    logger.warn('[facetime] Chrome custom tab failed; trying a default custom tab', e);
  }
  try {
    await WebBrowser.openBrowserAsync(url);
    return;
  } catch (e) {
    logger.warn('[facetime] custom tab failed; falling back to the default browser', e);
  }
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

/**
 * Start a FaceTime call — the LINK model.
 *
 * A headless Mac can't bridge THIS device into a native 1:1 call (that dial rings the
 * recipient but we can't join it, and it drops on answer). So the reliable model is a
 * FaceTime *link*: the Mac mints a link that INVITES the recipient(s) — it arrives in their
 * FaceTime as an invite, not just a bare URL — and we join the link in the phone's BROWSER
 * (the embedded WebView is unreliable for FaceTime-web). In dev (no server) a stub link is
 * shown in the in-app overlay.
 */
export function useFaceTime(): {
  startCall: (args: StartCallArgs) => Promise<void>;
  startCallTo: (args: StartCallToArgs) => Promise<void>;
} {
  const open = useFaceTimeStore((s) => s.open);

  const startCall = useCallback(
    async ({ chatGuid, video }: StartCallArgs): Promise<void> => {
      try {
        if (isDevServer()) {
          const stub = `https://facetime.apple.com/join#v=1&p=dev&k=${Date.now()}`;
          const { devSendFake } = await import('@features/conversations/devSeed');
          await devSendFake(chatGuid, stub);
          open({ link: stub, chatGuid, video });
          return;
        }
        // Invite the chat's participant(s) into the link (it shows up in their FaceTime),
        // drop the link into the thread as a tappable backup, then join it in the browser.
        const addresses = (await getChatParticipants(getDatabase(), chatGuid))
          .map((p) => p.address)
          .filter((a) => a.length > 0);
        const link = await faceTimeApi.createFaceTimeLink(http, addresses);
        if (!isFaceTimeLink(link)) throw new Error('server returned no FaceTime link');
        await send({ chatGuid, text: link });
        await openFaceTimeLink(link);
      } catch (err) {
        logger.warn('[facetime] failed to start call', err);
        Alert.alert('FaceTime', 'Couldn’t start the call. Make sure your server is connected.');
      }
    },
    [open],
  );

  const startCallTo = useCallback(
    async ({ addresses, video }: StartCallToArgs): Promise<void> => {
      const clean = addresses.map((a) => a.trim()).filter((a) => a.length > 0);
      if (clean.length === 0) {
        Alert.alert('FaceTime', 'Enter a phone number or email to call.');
        return;
      }
      try {
        if (isDevServer()) {
          open({ link: `https://facetime.apple.com/join#v=1&p=dev&k=${Date.now()}`, chatGuid: '', video });
          return;
        }
        // Invite the recipient(s) into the link (arrives in their FaceTime), text it as a
        // tappable backup, then join it in the phone's browser.
        const link = await faceTimeApi.createFaceTimeLink(http, clean);
        if (!isFaceTimeLink(link)) throw new Error('server returned no FaceTime link');
        try {
          await createNewChat(clean, link, 'iMessage');
        } catch (e) {
          logger.warn('[facetime] could not text the FaceTime link to the recipient(s)', e);
        }
        await openFaceTimeLink(link);
      } catch (err) {
        logger.warn('[facetime] start failed', err);
        Alert.alert('FaceTime', 'Couldn’t start the call. Make sure your server is connected.');
      }
    },
    [open],
  );

  return { startCall, startCallTo };
}
