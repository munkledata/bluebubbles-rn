import { useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/**
 * Whether the soft keyboard is currently up (tracks keyboardDidShow/keyboardDidHide).
 *
 * Exists for Android edge-to-edge (Expo SDK 56 / RN 0.85): legacy `adjustResize` no longer
 * pushes content, so chat-style screens wrap in `<KeyboardAvoidingView behavior="padding">` —
 * but the KAV should only contribute padding WHILE the keyboard is up (`enabled={kbVisible}`),
 * or it leaves a nav-bar-sized residual gap under the bottom bar after a show/hide cycle.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
