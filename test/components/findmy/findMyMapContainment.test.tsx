import { renderWithTheme, screen } from '../support/renderWithTheme';
import { FindMyMap, type MapMarker } from '@ui/findmy/FindMyMap';

describe('FindMyMap release containment', () => {
  it('mounts no WebView and exposes no marker identity or coordinates', async () => {
    const markers: MapMarker[] = [
      { id: 'private-id', lat: 40.123, lng: -105.456, label: 'Private Home' },
    ];

    await renderWithTheme(<FindMyMap markers={markers} focusId="private-id" />);

    expect(screen.getByTestId('findmy-map-disabled')).toBeTruthy();
    expect(screen.getByText(/Embedded map disabled for privacy/)).toBeTruthy();
    expect(screen.queryByText('Private Home')).toBeNull();
    expect(screen.queryByText(/40\.123|-105\.456|private-id/)).toBeNull();
  });
});
