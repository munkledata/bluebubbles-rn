import React from 'react';
import { StyleSheet, View } from 'react-native';
import { edgeFadeStops } from './edgeFadeStops';

interface EdgeFadeProps {
  edge: 'top' | 'bottom';
  /** Total veil height: the bar zone (held near-opaque) + the fade band beyond it. */
  height: number;
  /** Bar-zone height — the portion held near-opaque behind the floating header/composer. */
  holdHeight: number;
  /** Theme background hex the veil is tinted with (matches the frosted bar chips). */
  color: string;
}

/**
 * Transcript edge veil for wallpaper chats: the message list runs UNDER the transparent
 * header/composer, and this gradient dissolves rows as they scroll into the bar zone instead of
 * letting them hard-clip. Rendered with RN 0.85's built-in CSS-gradient backgrounds
 * (`experimental_backgroundImage`, new-arch) — no native gradient dependency needed.
 * Sits above the in-flow list (zIndex 1) and below the bar chrome (zIndex 2); never intercepts
 * touches.
 */
export function EdgeFade({ edge, height, holdHeight, color }: EdgeFadeProps): React.JSX.Element {
  const holdFraction = height > 0 ? holdHeight / height : 0;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.veil,
        edge === 'top' ? styles.top : styles.bottom,
        {
          height,
          experimental_backgroundImage: [
            {
              type: 'linear-gradient' as const,
              direction: edge === 'top' ? 'to bottom' : 'to top',
              colorStops: edgeFadeStops(color, holdFraction),
            },
          ],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  veil: { position: 'absolute', left: 0, right: 0, zIndex: 1 },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
