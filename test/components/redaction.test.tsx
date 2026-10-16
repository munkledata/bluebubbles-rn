/**
 * Ordinary exact-content controls for ConversationTile, MessageBubble, ReplyQuote, and Find My.
 * Leak-sensitive location cases sweep the whole rendered tree, including accessibility labels,
 * rather than checking only visible text nodes.
 */
import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from './support/renderWithTheme';
import type { InboxRow, MessagePreview, MessageRow } from '@db/repositories';

const mockBack = jest.fn();
const mockFindMyLoad = jest.fn(async () => undefined);
const mockFindMyRefresh = jest.fn(async () => undefined);
const mockUseFindMyPolling = jest.fn();
const mockAnimateCamera = jest.fn();
const mockFitToCoordinates = jest.fn();
const mockShowCallout = jest.fn();
let mockFindMyMapProps: Record<string, unknown> | undefined;
const originalAppStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

// ConversationTile imports markRead from the @/services barrel (pulls native modules at import);
// MessageBubble renders attachments through @ui/attachments (transitively ky, an untransformed ESM
// module). Neither is exercised here — stub both to keep the module graph off native/ESM code.
jest.mock('@/services', () => ({ markRead: jest.fn() }));
// Find My owns a narrower leaf dependency now; mock that boundary separately so this component
// test does not construct the real HttpClient (or pull its `ky` transport into Jest).
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@ui/attachments', () => ({
  AttachmentView: () => null,
  // MessageBubble now renders StickerOverlay; without it the element type is undefined.
  StickerOverlay: () => null,
}));

// --- Find My screen deps -----------------------------------------------------------------------
// The full @ui barrel drags expo-video/expo-image/ky; the screen only needs Screen/ScreenHeader/
// useTheme. Safe for the tile/bubble blocks below: both import ../theme and ../primitives by
// relative path and never touch the barrel.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('@utils', () => ({
  ...jest.requireActual('@utils'),
  safeOpenUrl: jest.fn(async () => true),
}));
// findmyStore imports findMyApi from @core/api, whose http.ts pulls `ky` (untransformed ESM).
// The store's network actions are neutered in beforeEach, so only the import needs satisfying.
jest.mock('@core/api', () => ({ findMyApi: {} }));
jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual('react') as typeof import('react');
  return {
    useRouter: () => ({ back: mockBack, push: jest.fn() }),
    useFocusEffect: (effect: React.EffectCallback) => ReactLib.useEffect(effect, [effect]),
  };
});
jest.mock('@features/findmy/useFindMyPolling', () => ({
  useFindMyPolling: (...args: unknown[]) => mockUseFindMyPolling(...args),
}));
jest.mock('react-native-maps', () => {
  const ReactLib = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  const Map = ReactLib.forwardRef(
    (
      { children, onMapReady, ...props }: React.PropsWithChildren<{ onMapReady?: () => void }>,
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
  const Marker = ReactLib.forwardRef((props: Record<string, unknown>, ref) => {
    ReactLib.useImperativeHandle(ref, () => ({ showCallout: mockShowCallout }));
    return ReactLib.createElement(View, props);
  });
  Marker.displayName = 'MockNativeMarker';
  return { __esModule: true, default: Map, Marker, PROVIDER_GOOGLE: 'google' };
});
jest.mock('@ui/findmy/FindMyMap', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  const actual = jest.requireActual('@ui/findmy/FindMyMap');
  return {
    ...actual,
    FindMyMap: (props: Record<string, unknown>) => {
      mockFindMyMapProps = props;
      return ReactLib.createElement(actual.FindMyMap, props);
    },
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// eslint-disable-next-line import/first
import { ConversationTile } from '@ui/conversations/ConversationTile';
// eslint-disable-next-line import/first
import { MessageBubble } from '@ui/conversations/MessageBubble';
// eslint-disable-next-line import/first
import FindMyScreen from '../../app/(app)/findmy';
// eslint-disable-next-line import/first
import { useFindMyStore } from '@state/findmyStore';
// eslint-disable-next-line import/first
import { useLockStore } from '@state/lockStore';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
const mockSafeOpenUrl = safeOpenUrl as jest.MockedFunction<typeof safeOpenUrl>;
const SECRET_NAME = 'Alice Wonderland';
const SECRET_TEXT = 'meet me at the docks at noon';

// Find My fixtures use distinct values so exact marker, focus, and encoded geo boundaries cannot
// accidentally pass by selecting another entity.
const SECRET_LAT = 43.847291;
const SECRET_LNG = -79.418533;
const SECRET_DEVICE = 'Craig’s iPhone';
const SECRET_ADDRESS = '1 Infinite Loop, Cupertino';
const SECRET_ITEM = 'Airport Tag / Gate A&B';
const SECRET_FRIEND = 'Morgan + Riley’s Location';
const SECRET_ITEM_ADDRESS = 'Location available';
const SECRET_FRIEND_ADDRESS = '221B Baker Street, London';
const SHARED_ENTITY_ID = 'shared-findmy-entity-7c41';

const LOCATED_DEVICE = {
  id: SHARED_ENTITY_ID,
  name: SECRET_DEVICE,
  batteryLevel: 0.634,
  latitude: SECRET_LAT,
  longitude: SECRET_LNG,
  address: SECRET_ADDRESS,
};

const LOCATED_ITEM = {
  id: SHARED_ENTITY_ID,
  name: SECRET_ITEM,
  batteryLevel: 0.876,
  latitude: 37.33182,
  longitude: -122.03118,
  address: null,
};

const LOCATED_FRIEND = {
  id: SHARED_ENTITY_ID,
  name: SECRET_FRIEND,
  latitude: 51.507351,
  longitude: -0.127758,
  address: SECRET_FRIEND_ADDRESS,
  lastUpdated: 1_700_000_000_000,
};

/**
 * Everything the user can actually perceive, as one string, for a leak sweep: rendered text nodes
 * plus every primitive prop value (accessibilityLabel/Hint, testID, the WebView's injected html…).
 *
 * Deliberately NOT `JSON.stringify(screen.toJSON())`, for two reasons found the hard way:
 *  1. It throws on cyclic prop values (React context Providers appear in props).
 *  2. More importantly it walks REACT ELEMENT BOOKKEEPING — an element sitting in a prop carries
 *     its own unrendered `props`, so a child that correctly redacts its input still showed the raw
 *     value via the element it was constructed from. That is a false positive: the data never
 *     reaches the screen. Elements are skipped here; whatever they actually RENDER is in the tree
 *     on its own and is still swept.
 * `style` is skipped so layout numbers can't collide with a coordinate prefix.
 */
function renderedText(): string {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const isElementish = (o: Record<string, unknown>): boolean =>
    '_owner' in o || '$$typeof' in o || ('props' in o && 'type' in o);

  const walkValue = (v: unknown): void => {
    if (v == null || typeof v === 'function') return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out.push(String(v));
      return;
    }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach(walkValue);
      return;
    }
    const o = v as Record<string, unknown>;
    if (isElementish(o)) return;
    for (const [k, val] of Object.entries(o)) {
      if (k === 'style') continue;
      walkValue(val);
    }
  };

  const walkNode = (n: unknown): void => {
    if (n == null) return;
    if (typeof n === 'string' || typeof n === 'number') {
      out.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(walkNode);
      return;
    }
    if (typeof n !== 'object') return;
    const node = n as { props?: Record<string, unknown>; children?: unknown };
    if (node.props) {
      for (const [k, val] of Object.entries(node.props)) {
        if (k === 'style' || k === 'children') continue;
        walkValue(val);
      }
    }
    walkNode(node.children);
  };

  walkNode(screen.toJSON());
  return out.join(' ');
}

/** Back-compat alias: the existing tile/bubble sweeps read as "the serialized tree". */
const serializeTree = renderedText;

function makeRow(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 1,
    guid: 'iMessage;-;+15551230000',
    chatIdentifier: '+15551230000',
    displayName: null,
    customName: null,
    customColor: null,
    style: 45,
    isPinned: 0,
    isArchived: 0,
    muteType: null,
    latestMessageDate: 1_700_000_000_000,
    lastReadMessageGuid: null,
    lastText: SECRET_TEXT,
    lastSubject: null,
    lastIsFromMe: 0,
    lastHasAttachments: 0,
    lastDate: 1_700_000_000_000,
    lastGuid: 'm1',
    lastAssociatedType: null,
    lastError: 0,
    participantCount: 1,
    participantNames: SECRET_NAME,
    participantAvatars: null,
    handleServices: null,
    unreadCount: 0,
    hasKnownSender: 1,
    ...overrides,
  };
}

type BubbleMsg = MessageRow & { replyPreview?: MessagePreview | null };

function makeMsg(over: Partial<BubbleMsg> = {}): BubbleMsg {
  return {
    id: 1,
    guid: 'msg-1',
    chatId: 1,
    handleId: null,
    text: SECRET_TEXT,
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 1_000,
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateRetracted: null,
    hasAttachments: 0,
    error: 0,
    sendState: 'sent',
    wasDeliveredQuietly: 0,
    didNotifyRecipient: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    associatedMessageEmoji: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: null,
    senderName: null,
    senderAvatar: null,
    senderService: null,
    ...over,
  };
}

beforeEach(() => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.clearAllMocks();
  mockFindMyMapProps = undefined;
  // Seed the REAL findmyStore and replace only its two async actions with observable stubs. The
  // route-to-polling boundary is asserted here; the supplemental polling suite owns the real
  // focus/AppState cadence and cleanup. Reset in beforeEach, never afterEach — a setState in
  // afterEach fires on the still-mounted tree and trips an act warning.
  useFindMyStore.setState({
    devices: [],
    items: [],
    friends: [],
    loading: false,
    refreshing: false,
    error: null,
    load: mockFindMyLoad,
    refresh: mockFindMyRefresh,
  });
  useLockStore.setState({ enabled: false, hydrated: true, locked: false });
});

afterAll(() => {
  if (originalAppStateDescriptor) {
    Object.defineProperty(AppState, 'currentState', originalAppStateDescriptor);
  }
});

describe('ConversationTile — exact content control', () => {
  it('shows the exact title + preview', async () => {
    await renderWithTheme(<ConversationTile row={makeRow()} onPress={() => {}} />);
    expect(screen.getByText(SECRET_NAME)).toBeTruthy();
    expect(screen.getByText(SECRET_TEXT)).toBeTruthy();
    expect(screen.queryByText('Contact')).toBeNull();
  });
});

describe('MessageBubble — exact content control', () => {
  it('shows the exact bubble text throughout the rendered host tree', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ text: SECRET_TEXT })} showTail />);
    expect(screen.getByText(SECRET_TEXT)).toBeTruthy();
    expect(screen.queryByText('Message')).toBeNull();
    expect(serializeTree()).toContain(SECRET_TEXT);
  });
});

describe('ReplyQuote via a reply bubble — exact content control', () => {
  const SECRET_QUOTE = 'the safe combination is 4815162342';
  const replyMsg = () =>
    makeMsg({
      text: SECRET_TEXT,
      threadOriginatorGuid: 'orig-1',
      replyPreview: {
        guid: 'orig-1',
        text: SECRET_QUOTE,
        senderName: SECRET_NAME,
        isFromMe: 0,
        hasAttachments: 0,
      },
    });

  it('shows the exact quoted sender and text throughout the rendered host tree', async () => {
    await renderWithTheme(<MessageBubble msg={replyMsg()} showTail />);
    expect(screen.getByText(SECRET_NAME)).toBeTruthy();
    expect(screen.getByText(SECRET_QUOTE)).toBeTruthy();
    expect(screen.queryByText('Contact')).toBeNull();
    const tree = serializeTree();
    expect(tree).toContain(SECRET_NAME);
    expect(tree).toContain(SECRET_QUOTE);
  });
});

describe('Find My screen — exact location routing', () => {
  const expectedMarkers = [
    {
      id: 'd:0',
      lat: LOCATED_DEVICE.latitude,
      lng: LOCATED_DEVICE.longitude,
      label: SECRET_DEVICE,
    },
    {
      id: 'i:0',
      lat: LOCATED_ITEM.latitude,
      lng: LOCATED_ITEM.longitude,
      label: SECRET_ITEM,
    },
    {
      id: 'p:0',
      lat: LOCATED_FRIEND.latitude,
      lng: LOCATED_FRIEND.longitude,
      label: SECRET_FRIEND,
    },
  ];

  it.each([
    {
      kind: 'device',
      tab: null,
      name: SECRET_DEVICE,
      subtitle: `${SECRET_ADDRESS} · 🔋 63%`,
      markerId: 'd:0',
      latitude: LOCATED_DEVICE.latitude,
      longitude: LOCATED_DEVICE.longitude,
    },
    {
      kind: 'item',
      tab: 'Items',
      name: SECRET_ITEM,
      subtitle: `${SECRET_ITEM_ADDRESS} · 🔋 88%`,
      markerId: 'i:0',
      latitude: LOCATED_ITEM.latitude,
      longitude: LOCATED_ITEM.longitude,
    },
    {
      kind: 'friend',
      tab: 'People',
      name: SECRET_FRIEND,
      subtitle: SECRET_FRIEND_ADDRESS,
      markerId: 'p:0',
      latitude: LOCATED_FRIEND.latitude,
      longitude: LOCATED_FRIEND.longitude,
    },
  ] as const)(
    'renders and routes the exact $kind marker, focus, details, and geo intent',
    async ({ tab, name, subtitle, markerId, latitude, longitude }) => {
      useFindMyStore.setState({
        devices: [LOCATED_DEVICE],
        items: [LOCATED_ITEM],
        friends: [LOCATED_FRIEND],
      });
      await renderWithTheme(<FindMyScreen />);

      await waitFor(() =>
        expect(mockFindMyMapProps).toEqual({ markers: expectedMarkers, focusRequest: null }),
      );
      expect(screen.getByTestId('findmy-native-map')).toBeTruthy();
      if (tab != null) {
        await act(async () => {
          fireEvent.press(screen.getByText(tab));
        });
      }
      expect(await screen.findByText(name)).toBeTruthy();
      expect(screen.getByText(subtitle)).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByText(name));
      });
      await waitFor(() =>
        expect(mockFindMyMapProps?.focusRequest).toEqual({ id: markerId, revision: 1 }),
      );

      await act(async () => {
        fireEvent.press(screen.getByText('Open ↗'));
      });
      expect(mockSafeOpenUrl).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        expect(mockSafeOpenUrl).toHaveBeenCalledWith(
          `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodeURIComponent(name)})`,
        ),
      );

      // Coordinates intentionally cross the native map bridge so it can draw each marker. They
      // must not become visible text, accessibility labels, or accessibility hints.
      for (const coordinate of [latitude, longitude]) {
        const text = String(coordinate);
        const pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        expect(screen.queryByText(text, { exact: false })).toBeNull();
        expect(screen.queryByLabelText(pattern)).toBeNull();
        expect(screen.queryByHintText(pattern)).toBeNull();
      }
    },
  );

  it('omits partial and non-finite points while keeping exact no-location copy inert', async () => {
    const unlocatedName = 'Unlocated Device 7c41';
    useFindMyStore.setState({
      devices: [
        {
          ...LOCATED_DEVICE,
          name: unlocatedName,
          latitude: SECRET_LAT,
          longitude: null,
          address: null,
          batteryLevel: Number.NaN,
        },
      ],
      items: [{ ...LOCATED_ITEM, latitude: Number.NaN }],
      friends: [{ ...LOCATED_FRIEND, longitude: Number.POSITIVE_INFINITY }],
    });
    await renderWithTheme(<FindMyScreen />);

    expect(screen.getByText(unlocatedName)).toBeTruthy();
    expect(screen.getByText('No location')).toBeTruthy();
    expect(screen.queryByText(/🔋/)).toBeNull();
    expect(screen.queryByText('Open ↗')).toBeNull();
    expect(screen.queryByTestId('findmy-native-map')).toBeNull();
    expect(mockFindMyMapProps).toBeUndefined();
    expect(mockSafeOpenUrl).not.toHaveBeenCalled();
  });

  it('loads on mount and preserves polling, refresh, and Back wiring', async () => {
    await renderWithTheme(<FindMyScreen />);

    await waitFor(() => expect(mockFindMyLoad).toHaveBeenCalledTimes(1));
    expect(mockUseFindMyPolling).toHaveBeenLastCalledWith(expect.any(Function));
    await act(async () => {
      fireEvent.press(screen.getByText('Refresh'));
    });
    expect(mockFindMyRefresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
