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
import { act, renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import type { AttachmentRow } from '@db/repositories';

const SF_LOC =
  'BEGIN:VCARD\nURL;type=pref:https://maps.apple.com/?ll=-122.4194\\,37.7749&q=-122.4194\\,37.7749\nEND:VCARD';

let mockLocText: string | ((path: string) => Promise<string>) = SF_LOC;
let mockLocBytes = 200;
const mockFileText = jest.fn(async (path: string): Promise<string> => {
  if (typeof mockLocText === 'function') return mockLocText(path);
  return mockLocText;
});

jest.mock('expo-file-system', () => ({
  File: class {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
    get size(): number {
      return mockLocBytes;
    }
    async text(): Promise<string> {
      return mockFileText(this.path);
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
// eslint-disable-next-line import/first
import { MAX_INLINE_TEXT_ATTACHMENT_BYTES } from '@ui/attachments/readBoundedTextAttachment';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';

const PRIVATE_FILENAME = 'private-home-location-a71c.loc.vcf';
const PRIVATE_PATH = 'file:///private-location-b82d.loc.vcf';
const PRIVATE_LOC =
  'BEGIN:VCARD\nURL;type=pref:https://maps.apple.com/?ll=-73.987654\\,40.765432&q=-73.987654\\,40.765432\nEND:VCARD';
const PRIVATE_COORDINATES = '40.7654, -73.9877';
const PRIVATE_GEO = 'geo:40.765432,-73.987654?q=40.765432,-73.987654';
const SECOND_PATH = 'file:///private-location-second-c93e.loc.vcf';
const SECOND_LOC =
  'BEGIN:VCARD\nURL;type=pref:https://maps.apple.com/?ll=151.2093\\,-33.8688&q=151.2093\\,-33.8688\nEND:VCARD';
const SECOND_COORDINATES = '-33.8688, 151.2093';
const SECOND_GEO = 'geo:-33.8688,151.2093?q=-33.8688,151.2093';
const UNAVAILABLE_COPY = 'Location unavailable.';
const UNAVAILABLE_LABEL = 'Location unavailable';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function regexFor(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function configuredPress(node: {
  props: Record<string, unknown>;
}): ((event: object) => void) | undefined {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  return readConfig().onPress;
}

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const onPress = configuredPress(node);
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

async function invokeConfiguredPress(press: () => void): Promise<void> {
  await act(async () => {
    press();
    await Promise.resolve();
  });
}

function expectPrivateLocationAbsent(tree: unknown, filename = PRIVATE_FILENAME): void {
  const json = JSON.stringify(tree);
  for (const canary of [
    filename,
    PRIVATE_PATH,
    PRIVATE_COORDINATES,
    '40.765432',
    '-73.987654',
    PRIVATE_GEO,
  ]) {
    expect(json).not.toContain(canary);
    expect(screen.queryByText(canary)).toBeNull();
    expect(screen.queryByLabelText(regexFor(canary))).toBeNull();
  }
}

function expectUnavailableLocation(tree: unknown, filename = PRIVATE_FILENAME): void {
  expectPrivateLocationAbsent(tree, filename);
  expect(screen.getByText('Location')).toBeTruthy();
  expect(screen.getByText(UNAVAILABLE_COPY)).toBeTruthy();
  const button = screen.getByRole('button', { name: UNAVAILABLE_LABEL });
  expect(button).toBeDisabled();
  expect(configuredPress(button)).toBeUndefined();
}

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
  resumeRealtimeDeliveries();
  useDownloadStore.setState({ progress: {}, status: {} });
  mockLocText = SF_LOC;
  mockLocBytes = 200;
  mockFileText.mockClear();
  (download as jest.Mock).mockClear();
  (safeOpenUrl as jest.Mock).mockClear();
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('LocationCard — parsed location once local', () => {
  it('renders transferName as the title and the lat,lon subtitle', async () => {
    await renderWithTheme(
      <LocationCard att={makeAtt({ localPath: 'file:///l/loc.vcf' })} isFromMe={false} />,
    );
    expect(await screen.findByText('37.7749, -122.4194')).toBeTruthy();
    expect(screen.getByText('Current Location.loc.vcf')).toBeTruthy();
  });

  it('title defaults to "Location" when there is no transferName', async () => {
    await renderWithTheme(
      <LocationCard
        att={makeAtt({ transferName: null, localPath: 'file:///l/loc.vcf' })}
        isFromMe={false}
      />,
    );
    expect(await screen.findByText('37.7749, -122.4194')).toBeTruthy();
    expect(screen.getByText('Location')).toBeTruthy();
  });

  it('an unparseable location leaves loc null → status subtitle ("Tap to open")', async () => {
    mockLocText = 'BEGIN:VCARD\nFN:Not a location\nEND:VCARD';
    await renderWithTheme(
      <LocationCard att={makeAtt({ localPath: 'file:///l/bad.vcf' })} isFromMe={false} />,
    );
    // loc stays null → subtitle is the idle status text (no coordinates rendered).
    expect(await screen.findByText('Tap to open')).toBeTruthy();
  });

  it('does not read an oversized location card into the JavaScript heap', async () => {
    mockLocBytes = MAX_INLINE_TEXT_ATTACHMENT_BYTES + 1;
    await renderWithTheme(
      <LocationCard att={makeAtt({ localPath: 'file:///l/huge.loc.vcf' })} isFromMe={false} />,
    );

    expect(await screen.findByText('Tap to open')).toBeTruthy();
    expect(mockFileText).not.toHaveBeenCalled();
  });

  it('withholds a parsed non-finite coordinate from both the host tree and geo intent', async () => {
    const read = deferred<string>();
    const hugeCoordinate = '9'.repeat(400);
    mockLocText = async () => read.promise;
    const view = await renderWithTheme(
      <LocationCard
        att={makeAtt({ transferName: 'non-finite-location.loc.vcf', localPath: PRIVATE_PATH })}
        isFromMe={false}
      />,
    );
    await waitFor(() => expect(mockFileText).toHaveBeenCalledWith(PRIVATE_PATH));

    await act(async () => {
      read.resolve(
        `BEGIN:VCARD\nURL;type=pref:https://maps.apple.com/?ll=${hugeCoordinate}\\,40.1\nEND:VCARD`,
      );
      await read.promise;
      await Promise.resolve();
    });

    expect(screen.getByText('Tap to open')).toBeTruthy();
    const json = JSON.stringify(view.toJSON());
    expect(json).not.toContain('Infinity');
    expect(json).not.toContain('geo:');
    await fireEvent.press(screen.getByRole('button', { name: 'Location' }));
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
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
    expect(download).toHaveBeenCalledWith(att, 'manual', expect.any(Object));
    const lease = (download as jest.Mock).mock.calls[0]?.[2] as RealtimeDeliveryLease;
    expect(lease.isCurrent()).toBe(true);
    expect(safeOpenUrl).not.toHaveBeenCalled();
  });

  it('localPath + parsed loc → opens a geo: URL with lat,lon (and query)', async () => {
    await renderWithTheme(
      <LocationCard att={makeAtt({ localPath: 'file:///l/loc.vcf' })} isFromMe={false} />,
    );
    await screen.findByText('37.7749, -122.4194');
    fireEvent.press(screen.getByLabelText('Location'));
    expect(safeOpenUrl).toHaveBeenCalledWith('geo:37.7749,-122.4194?q=37.7749,-122.4194');
    expect(download).not.toHaveBeenCalled();
  });

  it('localPath but unparseable loc → does nothing (no open, no download)', async () => {
    mockLocText = 'BEGIN:VCARD\nFN:Not a location\nEND:VCARD';
    await renderWithTheme(
      <LocationCard att={makeAtt({ localPath: 'file:///l/bad.vcf' })} isFromMe={false} />,
    );
    await screen.findByText('Tap to open');
    fireEvent.press(screen.getByLabelText('Location'));
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('LocationCard — account and recycled-row ownership', () => {
  it('positively renders a private filename/coordinate and opens the exact geo intent when visible', async () => {
    mockLocText = PRIVATE_LOC;
    const view = await renderWithTheme(
      <LocationCard
        att={makeAtt({ transferName: PRIVATE_FILENAME, localPath: PRIVATE_PATH })}
        isFromMe={false}
      />,
    );

    expect(await screen.findByText(PRIVATE_COORDINATES)).toBeTruthy();
    const json = JSON.stringify(view.toJSON());
    expect(json).toContain(PRIVATE_FILENAME);
    expect(json).toContain(PRIVATE_COORDINATES);
    const press = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));
    await invokeConfiguredPress(press);
    expect(safeOpenUrl).toHaveBeenCalledWith(PRIVATE_GEO);
  });

  it('does not read an initially retired account and gives a fresh remount exact access', async () => {
    mockLocText = PRIVATE_LOC;
    await pauseRealtimeDeliveries();
    const staleView = await renderWithTheme(
      <LocationCard
        att={makeAtt({ transferName: PRIVATE_FILENAME, localPath: PRIVATE_PATH })}
        isFromMe={false}
      />,
    );

    expectUnavailableLocation(staleView.toJSON());
    expect(mockFileText).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(safeOpenUrl).not.toHaveBeenCalled();

    await act(async () => {
      staleView.unmount();
    });
    resumeRealtimeDeliveries();
    const freshView = await renderWithTheme(
      <LocationCard
        att={makeAtt({ transferName: PRIVATE_FILENAME, localPath: PRIVATE_PATH })}
        isFromMe={false}
      />,
    );
    expect(await screen.findByText(PRIVATE_COORDINATES)).toBeTruthy();
    expect(JSON.stringify(freshView.toJSON())).toContain(PRIVATE_FILENAME);
    const freshPress = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));
    await invokeConfiguredPress(freshPress);
    expect(safeOpenUrl).toHaveBeenCalledWith(PRIVATE_GEO);
  });

  it('automatically hides a retired mounted account and blocks retained map and download callbacks', async () => {
    mockLocText = PRIVATE_LOC;
    const localAtt = makeAtt({
      guid: 'private-account-local-guid',
      transferName: PRIVATE_FILENAME,
      localPath: PRIVATE_PATH,
    });
    const downloadAtt = makeAtt({
      guid: 'private-account-download-guid',
      transferName: 'private-account-download-location-d04f.loc.vcf',
      localPath: null,
    });
    const cards = (): React.JSX.Element => (
      <>
        <LocationCard key="local" att={localAtt} isFromMe={false} />
        <LocationCard key="download" att={downloadAtt} isFromMe={false} />
      </>
    );
    const view = await renderWithTheme(cards());
    expect(await screen.findByText(PRIVATE_COORDINATES)).toBeTruthy();
    const visibleButtons = screen.getAllByRole('button', { name: 'Location' });
    const oldMapPress = retainConfiguredPress(visibleButtons[0]!);
    const oldDownloadPress = retainConfiguredPress(visibleButtons[1]!);

    await invokeConfiguredPress(oldDownloadPress);
    expect(download).toHaveBeenCalledWith(downloadAtt, 'manual', expect.any(Object));
    const originalLease = (download as jest.Mock).mock.calls[0]?.[2] as RealtimeDeliveryLease;
    expect(originalLease.isCurrent()).toBe(true);
    (download as jest.Mock).mockClear();

    await act(async () => {
      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
    });

    expect(originalLease.isCurrent()).toBe(false);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: UNAVAILABLE_LABEL })).toHaveLength(2),
    );
    expectPrivateLocationAbsent(view.toJSON());
    expect(JSON.stringify(view.toJSON())).not.toContain('private-account-download-location-d04f');
    const unavailableButtons = screen.getAllByRole('button', { name: UNAVAILABLE_LABEL });
    for (const button of unavailableButtons) {
      expect(button.props.accessibilityState?.disabled).toBe(true);
      expect(configuredPress(button)).toBeUndefined();
    }
    await invokeConfiguredPress(oldMapPress);
    await invokeConfiguredPress(oldDownloadPress);
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('revokes a parsed callback when the local path changes and opens only the replacement point', async () => {
    const replacement = deferred<string>();
    mockLocText = async (path) => (path === PRIVATE_PATH ? PRIVATE_LOC : replacement.promise);
    const first = makeAtt({ transferName: PRIVATE_FILENAME, localPath: PRIVATE_PATH });
    const second = makeAtt({
      transferName: 'private-replacement-location-e15a.loc.vcf',
      localPath: SECOND_PATH,
    });
    const view = await renderWithTheme(<LocationCard att={first} isFromMe={false} />);
    expect(await screen.findByText(PRIVATE_COORDINATES)).toBeTruthy();
    const oldPress = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));

    await view.rerender(<LocationCard att={second} isFromMe={false} />);
    expect(screen.queryByText(PRIVATE_COORDINATES)).toBeNull();
    await invokeConfiguredPress(oldPress);
    expect(safeOpenUrl).not.toHaveBeenCalled();

    await act(async () => {
      replacement.resolve(SECOND_LOC);
      await replacement.promise;
    });
    expect(await screen.findByText(SECOND_COORDINATES)).toBeTruthy();
    const freshPress = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));
    await invokeConfiguredPress(freshPress);
    expect(safeOpenUrl).toHaveBeenCalledWith(SECOND_GEO);
  });

  it('revokes the first A callback across A → B → A while a fresh A callback stays exact', async () => {
    mockLocText = async (path) => (path === PRIVATE_PATH ? PRIVATE_LOC : SECOND_LOC);
    const firstA = makeAtt({ guid: 'cycle-location-a', localPath: PRIVATE_PATH });
    const sourceB = makeAtt({ guid: 'cycle-location-b', localPath: SECOND_PATH });
    const view = await renderWithTheme(<LocationCard att={firstA} isFromMe={false} />);
    expect(await screen.findByText(PRIVATE_COORDINATES)).toBeTruthy();
    const oldAPress = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));

    await view.rerender(<LocationCard att={sourceB} isFromMe={false} />);
    expect(await screen.findByText(SECOND_COORDINATES)).toBeTruthy();
    await view.rerender(<LocationCard att={firstA} isFromMe={false} />);
    expect(await screen.findByText(PRIVATE_COORDINATES)).toBeTruthy();

    await invokeConfiguredPress(oldAPress);
    expect(safeOpenUrl).not.toHaveBeenCalled();
    const freshAPress = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));
    await invokeConfiguredPress(freshAPress);
    expect(safeOpenUrl).toHaveBeenCalledTimes(1);
    expect(safeOpenUrl).toHaveBeenCalledWith(PRIVATE_GEO);
  });

  it.each(['success', 'rejection'] as const)(
    'does not let a retired account parse %s disturb a fresh account card',
    async (outcome) => {
      const oldRead = deferred<string>();
      const rawError = 'retired-location-read-error-k61f';
      mockLocText = async (path) => (path === PRIVATE_PATH ? oldRead.promise : SECOND_LOC);
      const oldView = await renderWithTheme(
        <LocationCard
          att={makeAtt({ guid: 'retired-location-a', localPath: PRIVATE_PATH })}
          isFromMe={false}
        />,
      );
      await waitFor(() => expect(mockFileText).toHaveBeenCalledWith(PRIVATE_PATH));

      await act(async () => {
        await pauseRealtimeDeliveries();
      });
      expectUnavailableLocation(oldView.toJSON(), 'Current Location.loc.vcf');
      resumeRealtimeDeliveries();

      const freshView = await renderWithTheme(
        <LocationCard
          att={makeAtt({ guid: 'fresh-location-b', localPath: SECOND_PATH })}
          isFromMe={false}
        />,
      );
      expect(await screen.findByText(SECOND_COORDINATES)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') oldRead.resolve(PRIVATE_LOC);
        else oldRead.reject(new Error(rawError));
        await oldRead.promise.catch(() => undefined);
      });

      const oldJson = JSON.stringify(oldView.toJSON());
      const freshJson = JSON.stringify(freshView.toJSON());
      expect(oldJson).not.toContain(PRIVATE_COORDINATES);
      expect(oldJson).not.toContain(rawError);
      expect(freshJson).toContain(SECOND_COORDINATES);
      expect(freshJson).not.toContain(PRIVATE_COORDINATES);
      expect(freshJson).not.toContain(rawError);
      const freshPress = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));
      await invokeConfiguredPress(freshPress);
      expect(safeOpenUrl).toHaveBeenCalledTimes(1);
      expect(safeOpenUrl).toHaveBeenCalledWith(SECOND_GEO);
    },
  );

  it.each([
    {
      replacement: 'new path',
      next: makeAtt({ guid: 'att-loc-1', localPath: SECOND_PATH }),
      expectsFreshRead: true,
    },
    {
      replacement: 'no path',
      next: makeAtt({ guid: 'att-loc-1', localPath: null }),
      expectsFreshRead: false,
    },
    {
      replacement: 'new guid on the same path',
      next: makeAtt({ guid: 'private-recycled-guid-f26b', localPath: PRIVATE_PATH }),
      expectsFreshRead: true,
    },
  ])(
    'drops a delayed parse after replacement with $replacement',
    async ({ next, expectsFreshRead }) => {
      const oldRead = deferred<string>();
      let readCount = 0;
      mockLocText = async () => {
        readCount += 1;
        return readCount === 1 ? oldRead.promise : SECOND_LOC;
      };
      const view = await renderWithTheme(
        <LocationCard
          att={makeAtt({ transferName: PRIVATE_FILENAME, localPath: PRIVATE_PATH })}
          isFromMe={false}
        />,
      );
      await waitFor(() => expect(mockFileText).toHaveBeenCalledTimes(1));

      await view.rerender(<LocationCard att={next} isFromMe={false} />);
      if (expectsFreshRead) expect(await screen.findByText(SECOND_COORDINATES)).toBeTruthy();
      else expect(screen.getByText('Tap to open')).toBeTruthy();

      await act(async () => {
        oldRead.resolve(PRIVATE_LOC);
        await oldRead.promise;
      });
      expect(screen.queryByText(PRIVATE_COORDINATES)).toBeNull();
      expect(JSON.stringify(view.toJSON())).not.toContain(PRIVATE_GEO);
      expect(safeOpenUrl).not.toHaveBeenCalledWith(PRIVATE_GEO);
    },
  );

  it('keeps a fresh replacement point when the old path read later rejects', async () => {
    const oldRead = deferred<string>();
    const rawError = 'private-stale-location-read-error-h48d';
    mockLocText = async (path) => (path === PRIVATE_PATH ? oldRead.promise : SECOND_LOC);
    const view = await renderWithTheme(
      <LocationCard
        att={makeAtt({ transferName: PRIVATE_FILENAME, localPath: PRIVATE_PATH })}
        isFromMe={false}
      />,
    );
    await waitFor(() => expect(mockFileText).toHaveBeenCalledWith(PRIVATE_PATH));

    await view.rerender(
      <LocationCard
        att={makeAtt({
          transferName: 'private-fresh-location-j59e.loc.vcf',
          localPath: SECOND_PATH,
        })}
        isFromMe={false}
      />,
    );
    expect(await screen.findByText(SECOND_COORDINATES)).toBeTruthy();

    await act(async () => {
      oldRead.reject(new Error(rawError));
      await oldRead.promise.catch(() => undefined);
    });

    expect(screen.getByText(SECOND_COORDINATES)).toBeTruthy();
    expect(screen.queryByText(PRIVATE_COORDINATES)).toBeNull();
    expect(JSON.stringify(view.toJSON())).not.toContain(rawError);
    const freshPress = retainConfiguredPress(screen.getByRole('button', { name: 'Location' }));
    await invokeConfiguredPress(freshPress);
    expect(safeOpenUrl).toHaveBeenCalledWith(SECOND_GEO);
  });

  it('contains a current file-read rejection to the generic visible fallback', async () => {
    const read = deferred<string>();
    mockLocText = async () => read.promise;
    const rawError = 'private-location-read-error-g37c';
    const view = await renderWithTheme(
      <LocationCard
        att={makeAtt({ transferName: PRIVATE_FILENAME, localPath: PRIVATE_PATH })}
        isFromMe={false}
      />,
    );
    await waitFor(() => expect(mockFileText).toHaveBeenCalledTimes(1));

    await act(async () => {
      read.reject(new Error(rawError));
      await read.promise.catch(() => undefined);
    });
    expect(screen.getByText('Tap to open')).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).not.toContain(rawError);
    expect(safeOpenUrl).not.toHaveBeenCalled();
  });
});

describe('LocationCard — ordinary rendering control', () => {
  const LAT_PREFIX = '37.77';
  const treeJson = (): string => JSON.stringify(screen.toJSON());

  it('shows exact coordinates and opens the exact map intent', async () => {
    await renderWithTheme(
      <LocationCard att={makeAtt({ localPath: 'file:///l/loc.vcf' })} isFromMe={false} />,
    );
    expect(await screen.findByText('37.7749, -122.4194')).toBeTruthy();
    expect(treeJson()).toContain(LAT_PREFIX);
    fireEvent.press(screen.getByLabelText('Location'));
    await waitFor(() =>
      expect(safeOpenUrl).toHaveBeenCalledWith('geo:37.7749,-122.4194?q=37.7749,-122.4194'),
    );
  });
});
