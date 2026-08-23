import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
}

interface FindMyMapProps {
  markers: MapMarker[];
  /** Center + open this marker's popup (set when the user taps a list row). */
  focusId?: string | null;
  height?: number;
}

/** Shared so the disabled-map placeholder reserves a consistent visual height. */
export const FINDMY_MAP_HEIGHT = 260;

/**
 * Release-safe containment for the embedded map.
 *
 * The earlier implementation downloaded Leaflet JavaScript from a CDN into an unrestricted
 * WebView. That made third-party executable code part of a screen holding precise coordinates.
 * Until WEB-02 has a bundled map and a constrained navigation/resource policy, keep the device
 * list and its explicit system-maps “Open” actions but mount no WebView and send no map-tile
 * requests merely because this screen appeared.
 */
export function FindMyMap({ height = FINDMY_MAP_HEIGHT }: FindMyMapProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      testID="findmy-map-disabled"
      style={[
        styles.hidden,
        { minHeight: height, backgroundColor: theme.color.secondaryBackground },
      ]}
    >
      <Text style={[styles.hiddenText, { color: theme.color.secondaryLabel }]}>
        Embedded map disabled for privacy. Use Open on a location to view it in your maps app.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    width: '100%',
    minHeight: FINDMY_MAP_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
  },
  hiddenText: { fontSize: 15, textAlign: 'center' },
});
