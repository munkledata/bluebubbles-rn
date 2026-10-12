import React from 'react';
import { act, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockAnimateCamera = jest.fn();
const mockFitToCoordinates = jest.fn();
const mockShowCallout = jest.fn();

jest.mock('react-native-maps', () => {
  const ReactLib = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');

  const Map = ReactLib.forwardRef(
    (
      {
        children,
        onMapReady,
        ...props
      }: React.PropsWithChildren<{ onMapReady?: () => void; testID?: string }>,
      ref,
    ) => {
      ReactLib.useImperativeHandle(ref, () => ({
        animateCamera: mockAnimateCamera,
        fitToCoordinates: mockFitToCoordinates,
      }));
      ReactLib.useEffect(() => onMapReady?.(), [onMapReady]);
      return ReactLib.createElement(View, props, children);
    },
  );
  Map.displayName = 'MockNativeMap';

  const Marker = ReactLib.forwardRef(({ identifier, ...props }: { identifier?: string }, ref) => {
    ReactLib.useImperativeHandle(ref, () => ({ showCallout: mockShowCallout }));
    return ReactLib.createElement(View, {
      ...props,
      testID: `findmy-test-marker-${identifier ?? 'missing'}`,
    });
  });
  Marker.displayName = 'MockNativeMarker';

  return { __esModule: true, default: Map, Marker, PROVIDER_GOOGLE: 'google' };
});

// eslint-disable-next-line import/first
import { FindMyMap, MAX_FINDMY_MAP_MARKERS, type MapMarker } from '@ui/findmy/FindMyMap';

const MARKER: MapMarker = {
  id: 'private-id',
  lat: 40.123,
  lng: -105.456,
  label: 'Private Home',
};

describe('FindMyMap native containment', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the native Google provider without phone-location or provider escape controls', async () => {
    await renderWithTheme(<FindMyMap markers={[MARKER]} />);

    const map = screen.getByTestId('findmy-native-map');
    expect(map.props).toEqual(
      expect.objectContaining({
        provider: 'google',
        showsUserLocation: false,
        showsMyLocationButton: false,
        toolbarEnabled: false,
        poiClickEnabled: false,
        showsIndoors: false,
        userInterfaceStyle: 'dark',
      }),
    );
    expect(screen.getByTestId('findmy-test-marker-gator-findmy-0').props).toEqual(
      expect.objectContaining({
        coordinate: { latitude: MARKER.lat, longitude: MARKER.lng },
        title: MARKER.label,
      }),
    );
    await waitFor(() =>
      expect(mockAnimateCamera).toHaveBeenCalledWith(
        { center: { latitude: MARKER.lat, longitude: MARKER.lng }, zoom: 15 },
        { duration: 300 },
      ),
    );
  });

  it('fits multiple valid markers and withholds invalid or duplicate entries from native code', async () => {
    await renderWithTheme(
      <FindMyMap
        markers={[
          MARKER,
          { id: 'second', lat: 39.7392, lng: -104.9903, label: 'Tablet' },
          { id: 'invalid', lat: 91, lng: 0, label: 'Invalid' },
          { ...MARKER, lat: 1, lng: 2, label: 'Duplicate id' },
        ]}
      />,
    );

    expect(screen.getAllByTestId(/findmy-test-marker-/)).toHaveLength(2);
    await waitFor(() =>
      expect(mockFitToCoordinates).toHaveBeenCalledWith(
        [
          { latitude: MARKER.lat, longitude: MARKER.lng },
          { latitude: 39.7392, longitude: -104.9903 },
        ],
        {
          edgePadding: { top: 32, right: 32, bottom: 32, left: 32 },
          animated: true,
        },
      ),
    );
  });

  it('keeps the camera when a refresh republishes the same positions', async () => {
    // The screen refreshes every 60 s with new arrays; refitting each time zoomed out and closed an
    // open marker popup every minute.
    const second: MapMarker = { id: 'second', lat: 39.7392, lng: -104.9903, label: 'Tablet' };
    const view = await renderWithTheme(<FindMyMap markers={[MARKER, second]} />);
    await waitFor(() => expect(mockFitToCoordinates).toHaveBeenCalledTimes(1));

    await view.rerender(<FindMyMap markers={[{ ...MARKER }, { ...second }]} />);
    await view.rerender(<FindMyMap markers={[{ ...MARKER, lat: MARKER.lat + 0.00001 }, second]} />);
    expect(mockFitToCoordinates).toHaveBeenCalledTimes(1);

    await view.rerender(<FindMyMap markers={[{ ...MARKER, lat: MARKER.lat + 0.01 }, second]} />);
    await waitFor(() => expect(mockFitToCoordinates).toHaveBeenCalledTimes(2));
  });

  it('bounds native marker count and label size', async () => {
    const markers = Array.from({ length: MAX_FINDMY_MAP_MARKERS + 4 }, (_, index) => ({
      id: `marker-${index}`,
      lat: 40 + index / 10_000,
      lng: -105,
      label: index === 0 ? '😀'.repeat(200) : `Marker ${index}`,
    }));
    await renderWithTheme(<FindMyMap markers={markers} />);

    expect(screen.getAllByTestId(/findmy-test-marker-/)).toHaveLength(MAX_FINDMY_MAP_MARKERS);
    expect(
      Array.from(screen.getByTestId('findmy-test-marker-gator-findmy-0').props.title),
    ).toHaveLength(160);
  });

  it('passes punctuation and Unicode separators only as inert native marker text', async () => {
    const label = 'A&B <North> "HQ" / level-2\u2028Desk\u2029Wing';

    await renderWithTheme(<FindMyMap markers={[{ ...MARKER, label }]} />);

    expect(screen.getByTestId('findmy-test-marker-gator-findmy-0').props).toEqual(
      expect.objectContaining({
        title: label,
        accessibilityLabel: label,
      }),
    );
  });

  it('repeats focus for a second tap on the same row and opens its callout', async () => {
    const view = await renderWithTheme(
      <FindMyMap markers={[MARKER]} focusRequest={{ id: MARKER.id, revision: 1 }} />,
    );
    await waitFor(() => expect(mockShowCallout).toHaveBeenCalledTimes(1));

    await act(async () => {
      view.rerender(<FindMyMap markers={[MARKER]} focusRequest={{ id: MARKER.id, revision: 2 }} />);
    });

    await waitFor(() => expect(mockShowCallout).toHaveBeenCalledTimes(2));
    expect(mockAnimateCamera).toHaveBeenLastCalledWith(
      { center: { latitude: MARKER.lat, longitude: MARKER.lng }, zoom: 16 },
      { duration: 300 },
    );
  });

  it('mounts no native map when every coordinate is invalid', async () => {
    await renderWithTheme(<FindMyMap markers={[{ ...MARKER, lat: Number.NaN, lng: 999 }]} />);

    expect(screen.getByTestId('findmy-map-empty')).toBeTruthy();
    expect(screen.queryByTestId('findmy-native-map')).toBeNull();
  });
});
