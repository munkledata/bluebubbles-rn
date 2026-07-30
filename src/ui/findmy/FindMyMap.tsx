import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
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

/**
 * An interactive OpenStreetMap (Leaflet) map in a WebView — matches the old Flutter app's
 * FlutterMap+OSM approach, so it needs NO Google Maps API key or native maps module (the app
 * already bundles react-native-webview). Markers are injected as JSON; `focusId` recenters via
 * `injectJavaScript` (no reload). Leaflet + OSM tiles load from a CDN (Find My needs network
 * anyway). The HTML is app-generated (no user-supplied markup), and only lat/lng/label cross in.
 */
/** Shared so the redacted placeholder reserves exactly the map's visual weight. */
export const FINDMY_MAP_HEIGHT = 260;

export function FindMyMap({
  markers,
  focusId,
  height = FINDMY_MAP_HEIGHT,
}: FindMyMapProps): React.JSX.Element {
  const ref = useRef<WebView>(null);

  // Rebuild the doc only when the marker set changes (recenter uses injectJavaScript instead).
  const html = useMemo(() => buildHtml(markers), [markers]);

  // Recenter when the selected row changes (no reload).
  useEffect(() => {
    if (focusId) ref.current?.injectJavaScript(`focusMarker(${JSON.stringify(focusId)});true;`);
  }, [focusId]);

  return (
    // testID lets a test assert STRUCTURALLY that the WebView never mounts under redaction,
    // which is a stronger guarantee than searching the rendered tree for coordinate strings.
    <View testID="findmy-map" style={[styles.wrap, { height }]}>
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled
        // Recenter once the map is ready if a row is already selected.
        onLoadEnd={() => {
          if (focusId)
            ref.current?.injectJavaScript(`focusMarker(${JSON.stringify(focusId)});true;`);
        }}
        style={styles.web}
        // Don't let the map's own scroll/zoom fight the outer ScrollView until tapped.
        nestedScrollEnabled
      />
    </View>
  );
}

function buildHtml(markers: MapMarker[]): string {
  const data = JSON.stringify(
    markers.filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lng)),
  );
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>html,body,#map{height:100%;margin:0;padding:0;background:#111}</style>
</head><body><div id="map"></div>
<script>
  var markers = ${data};
  var map = L.map('map',{zoomControl:true,attributionControl:false}).setView([20,0],1);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
  var byId = {}; var pts = [];
  markers.forEach(function(m){
    var mk = L.marker([m.lat,m.lng]).addTo(map).bindPopup(m.label);
    byId[m.id]=mk; pts.push([m.lat,m.lng]);
  });
  if(pts.length===1){ map.setView(pts[0],15); }
  else if(pts.length>1){ map.fitBounds(pts,{padding:[40,40]}); }
  function focusMarker(id){ var mk=byId[id]; if(mk){ map.setView(mk.getLatLng(),16); mk.openPopup(); } }
  window.focusMarker = focusMarker;
  true;
</script>
</body></html>`;
}

/**
 * Stand-in for the map under redacted mode. Deliberately renders NO WebView and no coordinate —
 * the point of redacted mode is that a screenshot is safe, and a real pin on a real street is
 * more identifying than a name.
 */
export function FindMyMapHidden(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID="findmy-map-hidden"
      // `secondaryBackground`, NOT `groupedBackground`: the latter is byte-identical to
      // `background` in both shipped presets, so the panel would vanish into the page.
      // `minHeight`, NOT `height`: a fixed-height text box clips at Android font_scale 1.5.
      style={[styles.hidden, { backgroundColor: theme.color.secondaryBackground }]}
    >
      {/* An unstyled <Text> is near-black on Android — the colour must be explicit. */}
      <Text style={[styles.hiddenText, { color: theme.color.secondaryLabel }]}>
        Map hidden in Redacted Mode
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', backgroundColor: '#111' },
  web: { flex: 1, backgroundColor: '#111' },
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
