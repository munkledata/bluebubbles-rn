/**
 * LocationCard (src/ui/attachments/LocationCard.tsx): an Apple location (.loc.vcf) attachment as a
 * tappable map-link chip. Behaviors locked in, derived from the SOURCE:
 *   - once local, the text is read (expo-file-system `File`) and parsed with the pure parseVLocation
 *     (src/utils/vlocation.ts) → subtitle = `lat.toFixed(4), lon.toFixed(4)`; name = att.transferName
 *     ?? "Location".
 *   - BEFORE local (no localPath) subtitle is status-driven: idle → "Tap to open", downloading →
 *     "Downloading…", error → "Tap to retry".
 *   - a parse/read failure leaves loc null (subtitle falls back to the status text).
 *   - tap CONTRACT (onPress in source): no localPath → download(att); localPath + parsed loc →
 *     safeOpenUrl(`geo:<lat>,<lon>?q=<lat>,<lon>`); localPath but loc null → NOTHING (no open, no
 *     download).
 *
 * NOTE on the coordinate order: Apple encodes `ll=<longitude>,<latitude>` (longitude first — see
 * vlocation.ts), so the fixture `ll=-122.4194,37.7749` parses to latitude 37.7749, longitude
 * -122.4194, and the geo URL uses lat,lon → `geo:37.7749,-122.4194?q=37.7749,-122.4194`.
 *
 * In-file mocks: `expo-file-system` (controlled text via `mockLocText`), `@/services/download`
 * (native barrel — fn identity only), and `safeOpenUrl` on the `@utils` barrel (its REAL impl
 * dynamic-imports react-native, which throws under the jest-expo VM — so the geo-URL contract is
 * asserted at the safeOpenUrl boundary; parseVLocation stays the REAL util via requireActual).
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import type { AttachmentRow } from '@db/repositories';

const SF_LOC =
  'BEGIN:VCARD\nURL;type=pref:https://maps.apple.com/?ll=-122.4194\\,37.7749&q=-122.4194\\,37.7749\nEND:VCARD';

let mockLocText: string | (() => Promise<string>) = SF_LOC;

jest.mock('expo-file-system', () => ({
  File: class {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
    async text(): Promise<string> {
      if (typeof mockLocText === 'function') return mockLocText();
      return mockLocText;
    }
  },
}));

jest.mock('@/services/download', () => ({ download: jest.fn() }));

// safeOpenUrl's real impl dynamic-imports react-native (throws under the jest-expo VM); mock ONLY it,
// keeping every other @utils export (parseVLocation, etc.) real.
jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));

// eslint-disable-next-line import/first
import { LocationCard } from '@ui/attachments/LocationCard';
// eslint-disable-next-line import/first
import { download } from '@/services/download';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';

function makeAtt(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'att-loc-1',
    messageId: 1,
    mimeType: 'text/x-vlocation',
    transferName: 'Current Location.loc.vcf',
    totalBytes: 200,
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...overrides,
  };
}

beforeEach(() => {
  useDownloadStore.setState({ progress: {}, status: {} });
  mockLocText = SF_LOC;
  (download as jest.Mock).mockClear();
  (safeOpenUrl as jest.Mock).mockClear();
});

describe('LocationCard — parsed location once local', () => {
  it('renders transferName as the title and the lat,lon subtitle', async () => {
    await renderWithTheme(<LocationCard att={makeAtt({ localPath: 'file:///l/loc.vcf' })} isFromMe={false} />);
    expect(await screen.findByText('37.7749, -122.4194')).toBeTruthy();
    expect(screen.getByText('Current Location.loc.vcf')).toBeTruthy();
  });

  it('title defaults to "Location" when there is no transferName', async () => {
    await renderWithTheme(
      <LocationCard att={makeAtt({ transferName: null, localPath: 'file:///l/loc.vcf' })} isFromMe={false} />,
    );
    expect(await screen.findByText('37.7749, -122.4194')).toBeTruthy();
    expect(screen.getByText('Location')).toBeTruthy();
  });

  it('an unparseable location leaves loc null → status subtitle ("Tap to open")', async () => {
    mockLocText = 'BEGIN:VCARD\nFN:Not a location\nEND:VCARD';
    await renderWithTheme(<LocationCard att={makeAtt({ localPath: 'file:///l/bad.vcf' })} isFromMe={false} />);
    // loc stays null → subtitle is the idle status text (no coordinates rendered).
    expect(await screen.findByText('Tap to open')).toBeTruthy();
  });
});

describe('LocationCard — not-yet-local (status-driven subtitle)', () => {
  it('idle: "Tap to open"', async () => {
    await renderWithTheme(<LocationCard att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Tap to open')).toBeTruthy();
  });

  it('downloading: "Downloading…"', async () => {
    useDownloadStore.setState({ status: { 'att-loc-1': 'downloading' } });
    await renderWithTheme(<LocationCard att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Downloading…')).toBeTruthy();
  });

  it('error: "Tap to retry"', async () => {
    useDownloadStore.setState({ status: { 'att-loc-1': 'error' } });
    await renderWithTheme(<LocationCard att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Tap to retry')).toBeTruthy();
  });
});

describe('LocationCard — tap contract', () => {
  it('no localPath → download(att), no map opened', async () => {
    const att = makeAtt();
    await renderWithTheme(<LocationCard att={att} isFromMe={false} />);
    fireEvent.press(screen.getByLabelText('Location'));
    expect(download).toHaveBeenCalledWith(att);
    expect(safeOpenUrl).not.toHaveBeenCalled();
  });

  it('localPath + parsed loc → opens a geo: URL with lat,lon (and query)', async () => {
    await renderWithTheme(<LocationCard att={makeAtt({ localPath: 'file:///l/loc.vcf' })} isFromMe={false} />);
    await screen.findByText('37.7749, -122.4194');
    fireEvent.press(screen.getByLabelText('Location'));
    expect(safeOpenUrl).toHaveBeenCalledWith('geo:37.7749,-122.4194?q=37.7749,-122.4194');
    expect(download).not.toHaveBeenCalled();
  });

  it('localPath but unparseable loc → does nothing (no open, no download)', async () => {
    mockLocText = 'BEGIN:VCARD\nFN:Not a location\nEND:VCARD';
    await renderWithTheme(<LocationCard att={makeAtt({ localPath: 'file:///l/bad.vcf' })} isFromMe={false} />);
    await screen.findByText('Tap to open');
    fireEvent.press(screen.getByLabelText('Location'));
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});
