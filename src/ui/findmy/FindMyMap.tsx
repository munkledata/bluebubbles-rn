import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, {
  Marker,
  PROVIDER_GOOGLE,
  type MapMarker as NativeMapMarker,
} from 'react-native-maps';
import { useTheme } from '../theme';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
}

export interface MapFocusRequest {
  id: string;
  revision: number;
}

interface FindMyMapProps {
  markers: MapMarker[];
  /** A revision makes tapping the same row again recenter after the user pans away. */
  focusRequest?: MapFocusRequest | null;
  height?: number;
}

interface NativeMarker {
  id: string;
  nativeId: string;
  latitude: number;
  longitude: number;
  label: string;
}

/** Keep one hostile or accidental server response from exhausting the native map bridge. */
export const MAX_FINDMY_MAP_MARKERS = 256;
export const FINDMY_MAP_HEIGHT = 260;
const MAX_MARKER_LABEL_CODE_POINTS = 160;
const SINGLE_MARKER_ZOOM = 15;
const FOCUSED_MARKER_ZOOM = 16;
const CAMERA_ANIMATION_MS = 300;
const FIT_PADDING = { top: 32, right: 32, bottom: 32, left: 32 } as const;

function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function boundedLabel(value: string): string {
  let label = '';
  let count = 0;
  for (const codePoint of value) {
    if (count >= MAX_MARKER_LABEL_CODE_POINTS) break;
    label += codePoint;
    count += 1;
  }
  return label.trim() || 'Location';
}

/**
 * Native Google Maps view for server-provided Find My locations.
 *
 * Unlike the retired Leaflet path, this creates no HTML, downloads no executable JavaScript,
 * exposes no WebView navigation surface, and never requests this phone's own location. The owner
 * screen unmounts the whole component while unfocused, backgrounded, or App Locked so map-region
 * traffic exists only while the user can actually see the map.
 */
export function FindMyMap({
  markers,
  focusRequest,
  height = FINDMY_MAP_HEIGHT,
}: FindMyMapProps): React.JSX.Element {
  const theme = useTheme();
  const mapRef = useRef<MapView>(null);
  const markerRefs = useRef(new Map<string, NativeMapMarker>());
  const handledFocusRevisionRef = useRef<number | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const nativeMarkers = useMemo<NativeMarker[]>(() => {
    const result: NativeMarker[] = [];
    const seenIds = new Set<string>();
    for (const marker of markers) {
      if (result.length >= MAX_FINDMY_MAP_MARKERS) break;
      if (seenIds.has(marker.id) || !isValidCoordinate(marker.lat, marker.lng)) continue;
      seenIds.add(marker.id);
      result.push({
        id: marker.id,
        nativeId: `gator-findmy-${result.length}`,
        latitude: marker.lat,
        longitude: marker.lng,
        label: boundedLabel(marker.label),
      });
    }
    return result;
  }, [markers]);

  // A new location set gets a useful all-marker viewport. The separate focus effect below wins
  // on initial mount when a current row-selection request also exists. The screen refreshes every
  // 60 s with new arrays, so refit only when ids or positions (to about 11 m) really change;
  // refitting each time zoomed out and closed an open marker popup every minute.
  const fittedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mapReady || nativeMarkers.length === 0) return;
    const key = nativeMarkers
      .map(({ id, latitude, longitude }) => `${id}@${latitude.toFixed(4)},${longitude.toFixed(4)}`)
      .join('|');
    if (key === fittedKeyRef.current) return;
    fittedKeyRef.current = key;
    if (nativeMarkers.length === 1) {
      const marker = nativeMarkers[0]!;
      mapRef.current?.animateCamera(
        {
          center: { latitude: marker.latitude, longitude: marker.longitude },
          zoom: SINGLE_MARKER_ZOOM,
        },
        { duration: CAMERA_ANIMATION_MS },
      );
      return;
    }
    mapRef.current?.fitToCoordinates(
      nativeMarkers.map(({ latitude, longitude }) => ({ latitude, longitude })),
      { edgePadding: FIT_PADDING, animated: true },
    );
  }, [mapReady, nativeMarkers]);

  useEffect(() => {
    if (!mapReady || !focusRequest || handledFocusRevisionRef.current === focusRequest.revision) {
      return;
    }
    handledFocusRevisionRef.current = focusRequest.revision;
    const marker = nativeMarkers.find(({ id }) => id === focusRequest.id);
    if (!marker) return;
    mapRef.current?.animateCamera(
      {
        center: { latitude: marker.latitude, longitude: marker.longitude },
        zoom: FOCUSED_MARKER_ZOOM,
      },
      { duration: CAMERA_ANIMATION_MS },
    );
    markerRefs.current.get(marker.id)?.showCallout();
  }, [focusRequest, mapReady, nativeMarkers]);

  if (nativeMarkers.length === 0) {
    return (
      <View
        testID="findmy-map-empty"
        style={[styles.empty, { height, backgroundColor: theme.color.secondaryBackground }]}
      >
        <Text style={[styles.emptyText, { color: theme.color.secondaryLabel }]}>
          No valid locations to map.
        </Text>
      </View>
    );
  }

  const firstMarker = nativeMarkers[0]!;
  return (
    <View style={[styles.wrap, { height, backgroundColor: theme.color.secondaryBackground }]}>
      <MapView
        ref={mapRef}
        testID="findmy-native-map"
        provider={PROVIDER_GOOGLE}
        style={styles.map}
        initialRegion={{
          latitude: firstMarker.latitude,
          longitude: firstMarker.longitude,
          latitudeDelta: 0.03,
          longitudeDelta: 0.03,
        }}
        accessibilityLabel={`Google Maps view showing ${nativeMarkers.length} Find My ${
          nativeMarkers.length === 1 ? 'location' : 'locations'
        }`}
        loadingEnabled
        loadingBackgroundColor={theme.color.secondaryBackground}
        loadingIndicatorColor={theme.color.tint}
        mapPadding={FIT_PADDING}
        mapType="standard"
        moveOnMarkerPress
        userInterfaceStyle="dark"
        pitchEnabled={false}
        poiClickEnabled={false}
        rotateEnabled={false}
        showsBuildings={false}
        showsCompass={false}
        showsIndoors={false}
        showsIndoorLevelPicker={false}
        showsMyLocationButton={false}
        showsPointsOfInterests={false}
        showsTraffic={false}
        showsUserLocation={false}
        toolbarEnabled={false}
        onMapReady={() => setMapReady(true)}
      >
        {nativeMarkers.map((marker) => (
          <Marker
            key={marker.nativeId}
            ref={(instance) => {
              if (instance) markerRefs.current.set(marker.id, instance);
              else markerRefs.current.delete(marker.id);
            }}
            identifier={marker.nativeId}
            coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
            title={marker.label}
            accessibilityLabel={marker.label}
            tracksViewChanges={false}
          />
        ))}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', overflow: 'hidden' },
  map: { flex: 1 },
  empty: { width: '100%', alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyText: { fontSize: 15, textAlign: 'center' },
});
