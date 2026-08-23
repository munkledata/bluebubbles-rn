/**
 * ContactCard (src/ui/attachments/ContactCard.tsx): a vCard (.vcf) attachment shown as an
 * iOS-style contact chip. Behaviors locked in, all derived from the SOURCE:
 *   - once local, the .vcf text is read (expo-file-system `File`) and parsed with the pure
 *     parseVCard (src/utils/vcard.ts) → title = displayName, subtitle = first phone (else first
 *     email, else "Contact card"), avatar = up-to-2 initials of the title, a11y "Contact: <name>".
 *   - BEFORE it's local (no localPath) the subtitle is status-driven: idle → "Tap to view contact",
 *     downloading → "Downloading…" (+ spinner), error → "Tap to retry"; title falls back to
 *     att.transferName ?? "Contact".
 *   - a file-read failure resets the parsed contact to null (falls back to the status/transferName
 *     text) rather than crashing.
 *   - tap CONTRACT (onPress in source): localPath present → openAttachmentFile(localPath, mime),
 *     which converts the app-private path to a content:// FileProvider uri (a file:// uri cannot be
 *     handed to another app); absent → download(att). The RESULT is consumed: 'missing'
 *     re-downloads, 'no_handler' toasts.
 *   - alignSelf follows isFromMe (flex-end for me, flex-start for them).
 *
 * In-file mocks: `expo-file-system` (controlled .vcf text via `mockVcfText`, so no disk),
 * `@/services/download` (its barrel pulls native/ESM services — only the `download` fn identity
 * matters), and `safeOpenUrl` on the `@utils` barrel (its REAL impl lazy-imports react-native via
 * a dynamic `import()`, which throws under the jest-expo VM — so the open contract is asserted at
 * the safeOpenUrl boundary; parseVCard stays the REAL util via requireActual).
 */
import React from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import {
  act,
  fireEvent,
  renderWithTheme,
  screen,
  waitFor,
  type RenderResult,
} from '../support/renderWithTheme';
import { useDownloadStore } from '@state/downloadStore';
import type { AttachmentRow } from '@db/repositories';

// The parsed contact comes from this text; a function value lets a test make `.text()` reject.
let mockVcfText: string | ((path: string) => Promise<string>) =
  'BEGIN:VCARD\nFN:John Smith\nTEL;type=CELL:+1-555-1234\nEMAIL:john@example.com\nEND:VCARD';
let mockVcfBytes = 100;
const mockFileText = jest.fn(async (path: string): Promise<string> => {
  if (typeof mockVcfText === 'function') return mockVcfText(path);
  return mockVcfText;
});

jest.mock('expo-file-system', () => ({
  File: class {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
    get size(): number {
      return mockVcfBytes;
    }
    async text(): Promise<string> {
      return mockFileText(this.path);
    }
  },
}));

// The services barrel loads native modules at import; only the fn identity is used here.
jest.mock('@/services/download', () => ({ download: jest.fn() }));

// safeOpenUrl's real impl dynamic-imports react-native (throws under the jest-expo VM); mock ONLY it,
// keeping every other @utils export (parseVCard, etc.) real.
jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));

// The open path. Mocked wholesale so no native module enters this graph; the real behaviour is
// covered by the node test at test/services/openFile.test.ts.
const mockOpenAttachmentFile = jest.fn();
jest.mock('@/services/openFile', () => ({
  openAttachmentFile: (...args: unknown[]) => mockOpenAttachmentFile(...args),
}));

// eslint-disable-next-line import/first
import { ContactCard } from '@ui/attachments/ContactCard';
// eslint-disable-next-line import/first
import { download } from '@/services/download';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';
// eslint-disable-next-line import/first
import { MAX_INLINE_TEXT_ATTACHMENT_BYTES } from '@ui/attachments/readBoundedTextAttachment';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';

const PRIVATE_GUID = 'private-contact-guid-aa-7e31';
const PRIVATE_TRANSFER_NAME = 'private-contact-transfer-aa-0f92.vcf';
const PRIVATE_PATH = 'file:///private-contact-path-aa-a581.vcf';
const PRIVATE_NAME = 'Quasar Zephyr';
const PRIVATE_PHONE = '+1-303-555-0197-aa';
const PRIVATE_EMAIL = 'private-contact-aa-c640@example.test';
const PRIVATE_INITIALS = 'QZ';
const PRIVATE_VCARD = `BEGIN:VCARD\nFN:${PRIVATE_NAME}\nTEL;type=CELL:${PRIVATE_PHONE}\nEMAIL:${PRIVATE_EMAIL}\nEND:VCARD`;
const PRIVATE_EMAIL_PATH = 'file:///private-contact-email-path-aa-19e3.vcf';
const PRIVATE_EMAIL_NAME = 'Quasar Emailcanary';
const PRIVATE_EMAIL_INITIALS = 'QE';
const PRIVATE_EMAIL_VCARD = `BEGIN:VCARD\nFN:${PRIVATE_EMAIL_NAME}\nEMAIL:${PRIVATE_EMAIL}\nEND:VCARD`;

const SECOND_GUID = 'private-contact-guid-second-aa-b472';
const SECOND_TRANSFER_NAME = 'private-contact-transfer-second-aa-d603.vcf';
const SECOND_PATH = 'file:///private-contact-path-second-aa-e714.vcf';
const SECOND_NAME = 'Nimbus Quartz';
const SECOND_PHONE = '+1-720-555-0138-aa';
const SECOND_EMAIL = 'private-contact-second-aa-f825@example.test';
const SECOND_VCARD = `BEGIN:VCARD\nFN:${SECOND_NAME}\nTEL;type=CELL:${SECOND_PHONE}\nEMAIL:${SECOND_EMAIL}\nEND:VCARD`;

const UNAVAILABLE_COPY = 'Contact unavailable.';
const UNAVAILABLE_LABEL = 'Contact unavailable';
const HIDDEN = { includeHiddenElements: true } as const;

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
  const press = configuredPress(node);
  if (!press) throw new Error('Expected configured Pressable onPress');
  return () => press({ nativeEvent: {} });
}

async function invokeConfiguredPress(press: () => void): Promise<void> {
  await act(async () => {
    press();
    await Promise.resolve();
  });
}

function expectPrivateContactTreeAbsent(tree: unknown): void {
  const json = JSON.stringify(tree);
  for (const canary of [
    PRIVATE_GUID,
    PRIVATE_TRANSFER_NAME,
    PRIVATE_PATH,
    PRIVATE_NAME,
    PRIVATE_PHONE,
    PRIVATE_EMAIL,
    PRIVATE_INITIALS,
  ]) {
    expect(json).not.toContain(canary);
  }
}

function expectPrivateContactAbsent(tree: unknown): void {
  expectPrivateContactTreeAbsent(tree);
  for (const canary of [
    PRIVATE_GUID,
    PRIVATE_TRANSFER_NAME,
    PRIVATE_PATH,
    PRIVATE_NAME,
    PRIVATE_PHONE,
    PRIVATE_EMAIL,
    PRIVATE_INITIALS,
  ]) {
    expect(screen.queryByText(regexFor(canary), HIDDEN)).toBeNull();
    expect(screen.queryByLabelText(regexFor(canary))).toBeNull();
  }
}

function expectUnavailableContactTree(tree: unknown): void {
  expectPrivateContactTreeAbsent(tree);
  const json = JSON.stringify(tree);
  expect(json).toContain('Contact');
  expect(json).toContain(UNAVAILABLE_COPY);
  expect(json).toContain(`"accessibilityLabel":"${UNAVAILABLE_LABEL}"`);
  expect(json).toContain(`"disabled":true`);
}

function expectUnavailableContact(tree: unknown, expectedCount = 1): void {
  expectUnavailableContactTree(tree);
  expectPrivateContactAbsent(tree);
  expect(screen.getAllByText('Contact')).toHaveLength(expectedCount);
  expect(screen.getAllByText(UNAVAILABLE_COPY)).toHaveLength(expectedCount);
  const buttons = screen.getAllByRole('button', { name: UNAVAILABLE_LABEL });
  expect(buttons).toHaveLength(expectedCount);
  for (const button of buttons) {
    expect(button).toBeDisabled();
    expect(button.props.accessibilityState?.disabled).toBe(true);
    expect(configuredPress(button)).toBeUndefined();
  }
}

const isActivitySpinner = (node: { type: unknown }): boolean => node.type === 'ActivityIndicator';

function activitySpinners(view: RenderResult): unknown[] {
  if (!view.root) throw new Error('Expected a rendered ContactCard root');
  return view.root.queryAll(isActivitySpinner);
}

function makeAtt(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 1,
    guid: 'att-vcf-1',
    messageId: 1,
    mimeType: 'text/vcard',
    transferName: 'contact.vcf',
    totalBytes: 123,
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
  // Only the theme store is reset by the shared setup; this suite owns these stores + mocks.
  useDownloadStore.setState({ progress: {}, status: {} });
  useToastStore.setState({ current: null, queue: [] });
  mockVcfText =
    'BEGIN:VCARD\nFN:John Smith\nTEL;type=CELL:+1-555-1234\nEMAIL:john@example.com\nEND:VCARD';
  mockVcfBytes = 100;
  mockFileText.mockClear();
  (download as jest.Mock).mockClear();
  (safeOpenUrl as jest.Mock).mockClear();
  mockOpenAttachmentFile.mockReset().mockResolvedValue({ status: 'opened' });
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('ContactCard — parsed vCard once local', () => {
  it('renders the displayName, first phone, initials and a11y label', async () => {
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />,
    );
    // The effect reads + parses async → wait for the parsed name.
    expect(await screen.findByText('John Smith')).toBeTruthy();
    expect(screen.getByText('+1-555-1234')).toBeTruthy(); // first phone is the subtitle
    expect(screen.getByText('JS')).toBeTruthy(); // two-initial avatar
    expect(screen.getByLabelText('Contact: John Smith')).toBeTruthy();
  });

  it('falls back to the first email as subtitle when there is no phone', async () => {
    mockVcfText = 'BEGIN:VCARD\nFN:Jane Roe\nEMAIL:jane@example.com\nEND:VCARD';
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/j.vcf' })} isFromMe={false} />,
    );
    expect(await screen.findByText('Jane Roe')).toBeTruthy();
    expect(screen.getByText('jane@example.com')).toBeTruthy();
  });

  it('shows "Contact card" subtitle when the vCard has neither phone nor email', async () => {
    mockVcfText = 'BEGIN:VCARD\nFN:No Contact\nEND:VCARD';
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/n.vcf' })} isFromMe={false} />,
    );
    expect(await screen.findByText('No Contact')).toBeTruthy();
    expect(screen.getByText('Contact card')).toBeTruthy();
  });

  it('a read failure leaves the contact null → falls back to transferName + status text', async () => {
    mockVcfText = () => Promise.reject(new Error('read failed'));
    await renderWithTheme(
      <ContactCard
        att={makeAtt({ localPath: 'file:///c/bad.vcf', transferName: 'bob.vcf' })}
        isFromMe={false}
      />,
    );
    // contact stays null → title = transferName, subtitle = idle status text.
    expect(await screen.findByText('bob.vcf')).toBeTruthy();
    expect(screen.getByText('Tap to view contact')).toBeTruthy();
  });

  it('does not read an oversized vCard into the JavaScript heap', async () => {
    mockVcfBytes = MAX_INLINE_TEXT_ATTACHMENT_BYTES + 1;
    await renderWithTheme(
      <ContactCard
        att={makeAtt({ localPath: 'file:///c/huge.vcf', transferName: 'huge.vcf' })}
        isFromMe={false}
      />,
    );

    expect(await screen.findByText('Tap to view contact')).toBeTruthy();
    expect(mockFileText).not.toHaveBeenCalled();
  });
});

describe('ContactCard — not-yet-local (status-driven subtitle)', () => {
  it('idle: title from transferName and "Tap to view contact"', async () => {
    await renderWithTheme(
      <ContactCard att={makeAtt({ transferName: 'bob.vcf' })} isFromMe={false} />,
    );
    expect(screen.getByText('bob.vcf')).toBeTruthy();
    expect(screen.getByText('Tap to view contact')).toBeTruthy();
  });

  it('title defaults to "Contact" when there is no transferName', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={false} />);
    expect(screen.getByText('Contact')).toBeTruthy();
  });

  it('downloading: shows "Downloading…"', async () => {
    useDownloadStore.setState({ status: { 'att-vcf-1': 'downloading' } });
    const view = await renderWithTheme(<ContactCard att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Downloading…')).toBeTruthy();
    expect(activitySpinners(view)).toHaveLength(1);
  });

  it('error: shows "Tap to retry"', async () => {
    useDownloadStore.setState({ status: { 'att-vcf-1': 'error' } });
    await renderWithTheme(<ContactCard att={makeAtt()} isFromMe={false} />);
    expect(screen.getByText('Tap to retry')).toBeTruthy();
  });
});

describe('ContactCard — tap contract', () => {
  it('no localPath → download(att)', async () => {
    const att = makeAtt({ transferName: null }); // title defaults to "Contact"
    await renderWithTheme(<ContactCard att={att} isFromMe={false} />);
    await fireEvent.press(screen.getByLabelText('Contact: Contact'));
    expect(download).toHaveBeenCalledWith(att, 'manual', expect.any(Object));
    const lease = (download as jest.Mock).mock.calls[0]?.[2] as RealtimeDeliveryLease;
    expect(lease.isCurrent()).toBe(true);
    expect(mockOpenAttachmentFile).not.toHaveBeenCalled();
  });

  // FAILS ON THE OLD CODE, which handed the app-private file:// path to safeOpenUrl — a uri
  // Android forbids passing to another app, so the tap silently did nothing.
  it('localPath present → openAttachmentFile, never safeOpenUrl', async () => {
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />,
    );
    await screen.findByText('John Smith');
    await fireEvent.press(screen.getByLabelText('Contact: John Smith'));
    expect(mockOpenAttachmentFile).toHaveBeenCalledWith('file:///c/contact.vcf', 'text/vcard');
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('a missing local file re-downloads (the inline card would be empty too)', async () => {
    mockOpenAttachmentFile.mockResolvedValue({ status: 'missing' });
    const att = makeAtt({ localPath: 'file:///c/contact.vcf' });
    await renderWithTheme(<ContactCard att={att} isFromMe={false} />);
    await screen.findByText('John Smith');
    await fireEvent.press(screen.getByLabelText('Contact: John Smith'));
    await waitFor(() => expect(download).toHaveBeenCalledWith(att, 'manual', expect.any(Object)));
  });

  it('toasts when nothing on the device can open a contact card', async () => {
    mockOpenAttachmentFile.mockResolvedValue({ status: 'no_handler' });
    await renderWithTheme(
      <ContactCard att={makeAtt({ localPath: 'file:///c/contact.vcf' })} isFromMe={false} />,
    );
    await screen.findByText('John Smith');
    await fireEvent.press(screen.getByLabelText('Contact: John Smith'));
    await waitFor(() => expect(useToastStore.getState().current?.message).toMatch(/contact cards/));
  });
});

describe('ContactCard — alignment follows isFromMe', () => {
  const alignOf = (): ViewStyle['alignSelf'] =>
    (StyleSheet.flatten(screen.getByLabelText('Contact: Contact').props.style) as ViewStyle)
      .alignSelf;

  it('flex-end when from me', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={true} />);
    expect(alignOf()).toBe('flex-end');
  });

  it('flex-start when from them', async () => {
    await renderWithTheme(<ContactCard att={makeAtt({ transferName: null })} isFromMe={false} />);
    expect(alignOf()).toBe('flex-start');
  });
});

describe('ContactCard — source and account ownership', () => {
  function privateAttachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
    return makeAtt({
      guid: PRIVATE_GUID,
      transferName: PRIVATE_TRANSFER_NAME,
      localPath: PRIVATE_PATH,
      ...overrides,
    });
  }

  function secondAttachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
    return makeAtt({
      id: 2,
      guid: SECOND_GUID,
      transferName: SECOND_TRANSFER_NAME,
      localPath: SECOND_PATH,
      ...overrides,
    });
  }

  it('positively renders raw contact fields and uses exact open/download boundaries while visible', async () => {
    mockVcfText = async (path) =>
      path === PRIVATE_EMAIL_PATH ? PRIVATE_EMAIL_VCARD : PRIVATE_VCARD;
    const local = privateAttachment();
    const emailLocal = privateAttachment({
      id: 3,
      guid: 'private-email-guid-aa-8525',
      localPath: PRIVATE_EMAIL_PATH,
    });
    const notLocal = privateAttachment({
      id: 4,
      guid: 'private-download-guid-aa-9636',
      localPath: null,
    });
    const view = await renderWithTheme(
      <>
        <ContactCard key="local" att={local} isFromMe={false} />
        <ContactCard key="email" att={emailLocal} isFromMe={false} />
        <ContactCard key="download" att={notLocal} isFromMe={false} />
      </>,
    );

    expect(await screen.findByText(PRIVATE_NAME)).toBeTruthy();
    expect(screen.getByText(PRIVATE_PHONE)).toBeTruthy();
    expect(screen.getByText(PRIVATE_INITIALS)).toBeTruthy();
    expect(screen.getByText(PRIVATE_EMAIL_NAME)).toBeTruthy();
    expect(screen.getByText(PRIVATE_EMAIL)).toBeTruthy();
    expect(screen.getByText(PRIVATE_EMAIL_INITIALS)).toBeTruthy();
    expect(screen.getByText(PRIVATE_TRANSFER_NAME)).toBeTruthy();
    expect(screen.getByRole('button', { name: `Contact: ${PRIVATE_NAME}` })).toBeTruthy();
    expect(JSON.stringify(view.toJSON())).toContain(PRIVATE_EMAIL);

    const localPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
    );
    await invokeConfiguredPress(localPress);
    expect(mockOpenAttachmentFile).toHaveBeenCalledWith(PRIVATE_PATH, 'text/vcard');

    const downloadPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Contact: ${PRIVATE_TRANSFER_NAME}` }),
    );
    await invokeConfiguredPress(downloadPress);
    expect(download).toHaveBeenCalledWith(notLocal, 'manual', expect.any(Object));
    const lease = (download as jest.Mock).mock.calls[0]?.[2] as RealtimeDeliveryLease;
    expect(lease.isCurrent()).toBe(true);
  });

  it('does not read an initially retired account and gives a fresh remount exact access', async () => {
    mockVcfText = PRIVATE_VCARD;
    await pauseRealtimeDeliveries();
    const staleView = await renderWithTheme(
      <ContactCard att={privateAttachment()} isFromMe={false} />,
    );

    expectUnavailableContact(staleView.toJSON());
    expect(activitySpinners(staleView)).toHaveLength(0);
    expect(mockFileText).not.toHaveBeenCalled();
    expect(mockOpenAttachmentFile).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();

    await act(async () => {
      staleView.unmount();
    });
    resumeRealtimeDeliveries();
    await renderWithTheme(<ContactCard att={privateAttachment()} isFromMe={false} />);
    const freshPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
    );
    expect(mockFileText).toHaveBeenCalledWith(PRIVATE_PATH);
    await invokeConfiguredPress(freshPress);
    expect(mockOpenAttachmentFile).toHaveBeenCalledWith(PRIVATE_PATH, 'text/vcard');
  });

  it.each([
    ['success', 'a new path', secondAttachment({ guid: PRIVATE_GUID }), true],
    ['rejection', 'a new path', secondAttachment({ guid: PRIVATE_GUID }), true],
    ['success', 'no path', secondAttachment({ guid: PRIVATE_GUID, localPath: null }), false],
    ['rejection', 'no path', secondAttachment({ guid: PRIVATE_GUID, localPath: null }), false],
    ['success', 'a new guid on the same path', secondAttachment({ localPath: PRIVATE_PATH }), true],
    [
      'rejection',
      'a new guid on the same path',
      secondAttachment({
        guid: 'private-contact-same-path-reject-aa-4a7d',
        localPath: PRIVATE_PATH,
      }),
      true,
    ],
  ] as const)(
    'does not let stale parse %s survive replacement by %s',
    async (outcome, _replacement, next, expectsFreshRead) => {
      const oldRead = deferred<string>();
      const rawError = 'private-contact-old-source-read-error-aa-5b8e';
      let reads = 0;
      mockVcfText = async () => {
        reads += 1;
        return reads === 1 ? oldRead.promise : SECOND_VCARD;
      };
      const view = await renderWithTheme(
        <ContactCard att={privateAttachment()} isFromMe={false} />,
      );
      await waitFor(() => expect(mockFileText).toHaveBeenCalledTimes(1));

      await view.rerender(<ContactCard att={next} isFromMe={false} />);
      if (expectsFreshRead) {
        expect(await screen.findByText(SECOND_NAME)).toBeTruthy();
      } else {
        expect(screen.getByText(SECOND_TRANSFER_NAME)).toBeTruthy();
        expect(screen.getByText('Tap to view contact')).toBeTruthy();
      }

      await act(async () => {
        if (outcome === 'success') oldRead.resolve(PRIVATE_VCARD);
        else oldRead.reject(new Error(rawError));
        await oldRead.promise.catch(() => undefined);
      });

      expectPrivateContactAbsent(view.toJSON());
      expect(JSON.stringify(view.toJSON())).not.toContain(rawError);
      if (expectsFreshRead) {
        expect(screen.getByText(SECOND_NAME)).toBeTruthy();
        expect(screen.getByText(SECOND_PHONE)).toBeTruthy();
      } else {
        expect(screen.getByText(SECOND_TRANSFER_NAME)).toBeTruthy();
      }
    },
  );

  it('revokes the first A callback across A → B → A while a fresh A opens exactly', async () => {
    mockVcfText = async (path) => (path === PRIVATE_PATH ? PRIVATE_VCARD : SECOND_VCARD);
    const sourceA = privateAttachment();
    const sourceB = secondAttachment();
    const view = await renderWithTheme(<ContactCard att={sourceA} isFromMe={false} />);
    const oldAPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
    );

    await view.rerender(<ContactCard att={sourceB} isFromMe={false} />);
    expect(await screen.findByText(SECOND_NAME)).toBeTruthy();
    await view.rerender(<ContactCard att={sourceA} isFromMe={false} />);
    const freshAPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
    );
    await invokeConfiguredPress(oldAPress);
    expect(mockOpenAttachmentFile).not.toHaveBeenCalled();
    await invokeConfiguredPress(freshAPress);
    expect(mockOpenAttachmentFile).toHaveBeenCalledTimes(1);
    expect(mockOpenAttachmentFile).toHaveBeenCalledWith(PRIVATE_PATH, 'text/vcard');
  });

  it('revokes no-path callbacks across A → B → A while fresh callbacks retain the exact lease', async () => {
    const first = privateAttachment({ localPath: null });
    const second = secondAttachment({ localPath: null });
    const view = await renderWithTheme(<ContactCard att={first} isFromMe={false} />);
    const oldAPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Contact: ${PRIVATE_TRANSFER_NAME}` }),
    );

    await invokeConfiguredPress(oldAPress);
    expect(download).toHaveBeenCalledWith(first, 'manual', expect.any(Object));
    const originalLease = (download as jest.Mock).mock.calls[0]?.[2] as RealtimeDeliveryLease;
    expect(originalLease.isCurrent()).toBe(true);
    (download as jest.Mock).mockClear();

    await view.rerender(<ContactCard att={second} isFromMe={false} />);
    await invokeConfiguredPress(oldAPress);
    expect(download).not.toHaveBeenCalled();
    const freshBPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Contact: ${SECOND_TRANSFER_NAME}` }),
    );
    await invokeConfiguredPress(freshBPress);
    expect(download).toHaveBeenCalledWith(second, 'manual', originalLease);
    (download as jest.Mock).mockClear();

    await view.rerender(<ContactCard att={first} isFromMe={false} />);
    await invokeConfiguredPress(oldAPress);
    await invokeConfiguredPress(freshBPress);
    expect(download).not.toHaveBeenCalled();
    const freshAPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Contact: ${PRIVATE_TRANSFER_NAME}` }),
    );
    await invokeConfiguredPress(freshAPress);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(first, 'manual', originalLease);
    expect(originalLease.isCurrent()).toBe(true);
  });

  it('automatically hides a retired account and revokes retained open and download callbacks', async () => {
    mockVcfText = PRIVATE_VCARD;
    const localAtt = privateAttachment();
    const downloadAtt = privateAttachment({
      id: 4,
      guid: 'private-contact-account-download-aa-27d1',
      localPath: null,
    });
    const cards = (): React.JSX.Element => (
      <>
        <ContactCard key="local" att={localAtt} isFromMe={false} />
        <ContactCard key="download" att={downloadAtt} isFromMe={false} />
      </>
    );
    const view = await renderWithTheme(cards());
    const oldOpenPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
    );
    const oldDownloadPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Contact: ${PRIVATE_TRANSFER_NAME}` }),
    );
    await invokeConfiguredPress(oldOpenPress);
    expect(mockOpenAttachmentFile).toHaveBeenCalledWith(PRIVATE_PATH, 'text/vcard');
    mockOpenAttachmentFile.mockClear();
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
    expectUnavailableContact(view.toJSON(), 2);
    await invokeConfiguredPress(oldOpenPress);
    await invokeConfiguredPress(oldDownloadPress);
    expect(mockOpenAttachmentFile).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();

    await act(async () => {
      view.unmount();
    });
    await renderWithTheme(<ContactCard att={downloadAtt} isFromMe={false} />);
    const freshPress = retainConfiguredPress(
      screen.getByRole('button', { name: `Contact: ${PRIVATE_TRANSFER_NAME}` }),
    );
    await invokeConfiguredPress(freshPress);
    expect(download).toHaveBeenCalledWith(downloadAtt, 'manual', expect.any(Object));
    const freshLease = (download as jest.Mock).mock.calls[0]?.[2] as RealtimeDeliveryLease;
    expect(freshLease.isCurrent()).toBe(true);
    expect(freshLease).not.toBe(originalLease);
  });

  it.each(['success', 'rejection'] as const)(
    'drops a delayed parse %s after account retirement without disturbing a fresh account card',
    async (outcome) => {
      const read = deferred<string>();
      const rawError = 'private-contact-account-read-error-aa-6c9f';
      mockVcfText = async (path) => (path === PRIVATE_PATH ? read.promise : SECOND_VCARD);
      const oldView = await renderWithTheme(
        <ContactCard att={privateAttachment()} isFromMe={false} />,
      );
      await waitFor(() => expect(mockFileText).toHaveBeenCalledTimes(1));

      await act(async () => {
        await pauseRealtimeDeliveries();
      });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: UNAVAILABLE_LABEL })).toBeTruthy(),
      );
      expectUnavailableContact(oldView.toJSON());
      resumeRealtimeDeliveries();
      const freshView = await renderWithTheme(
        <ContactCard att={secondAttachment()} isFromMe={false} />,
      );
      expect(await screen.findByText(SECOND_NAME)).toBeTruthy();

      await act(async () => {
        if (outcome === 'success') read.resolve(PRIVATE_VCARD);
        else read.reject(new Error(rawError));
        await read.promise.catch(() => undefined);
      });

      expectUnavailableContactTree(oldView.toJSON());
      expect(JSON.stringify(oldView.toJSON())).not.toContain(rawError);
      expect(JSON.stringify(freshView.toJSON())).toContain(SECOND_NAME);
      expect(JSON.stringify(freshView.toJSON())).toContain(SECOND_PHONE);
      expect(JSON.stringify(freshView.toJSON())).not.toContain(rawError);
    },
  );
});

describe('ContactCard — native open result ownership', () => {
  function localAttachment(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
    return makeAtt({
      guid: PRIVATE_GUID,
      transferName: PRIVATE_TRANSFER_NAME,
      localPath: PRIVATE_PATH,
      ...overrides,
    });
  }

  it.each([
    ['error result', { status: 'error' }, false],
    ['rejected promise', new Error('private-contact-native-error-aa-7da0'), true],
  ] as const)(
    'publishes fixed copy for a current %s without raw error text',
    async (_case, result, rejects) => {
      mockVcfText = PRIVATE_VCARD;
      if (rejects) mockOpenAttachmentFile.mockRejectedValueOnce(result);
      else mockOpenAttachmentFile.mockResolvedValueOnce(result);
      const view = await renderWithTheme(<ContactCard att={localAttachment()} isFromMe={false} />);
      const press = retainConfiguredPress(
        await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
      );

      await invokeConfiguredPress(press);

      await waitFor(() =>
        expect(useToastStore.getState().current?.message).toBe('Couldn’t open this contact card'),
      );
      expect(JSON.stringify(view.toJSON())).not.toContain('private-contact-native-error-aa-7da0');
    },
  );

  it.each([
    ['missing', 'source', { status: 'missing' }, false, 'path'],
    ['error', 'account', { status: 'error' }, false, null],
    ['rejection', 'source', new Error('private-contact-revoked-error-aa-8eb1'), true, 'guid'],
    ['rejection', 'account', new Error('private-contact-revoked-error-aa-8eb1'), true, null],
  ] as const)(
    'suppresses a delayed %s outcome after %s revocation',
    async (_outcome, revocation, result, rejects, sourceVariant) => {
      const nativeOpen = deferred<{ status: string }>();
      mockVcfText = async (path) => (path === PRIVATE_PATH ? PRIVATE_VCARD : SECOND_VCARD);
      mockOpenAttachmentFile.mockReturnValueOnce(nativeOpen.promise);
      const sourceA = localAttachment();
      const view = await renderWithTheme(<ContactCard att={sourceA} isFromMe={false} />);
      const press = retainConfiguredPress(
        await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
      );
      await invokeConfiguredPress(press);
      expect(mockOpenAttachmentFile).toHaveBeenCalledWith(PRIVATE_PATH, 'text/vcard');

      let freshButtonName: string;
      let freshPath: string;
      if (revocation === 'source') {
        const replacement =
          sourceVariant === 'path'
            ? localAttachment({ guid: PRIVATE_GUID, localPath: SECOND_PATH })
            : localAttachment({ guid: SECOND_GUID, localPath: PRIVATE_PATH });
        await view.rerender(<ContactCard att={replacement} isFromMe={false} />);
        const replacementName = sourceVariant === 'path' ? SECOND_NAME : PRIVATE_NAME;
        expect(await screen.findByText(replacementName)).toBeTruthy();
        if (_outcome === 'missing') {
          await view.rerender(<ContactCard att={sourceA} isFromMe={false} />);
          expect(await screen.findByText(PRIVATE_NAME)).toBeTruthy();
          freshButtonName = `Contact: ${PRIVATE_NAME}`;
          freshPath = PRIVATE_PATH;
        } else {
          freshButtonName = `Contact: ${replacementName}`;
          freshPath = replacement.localPath ?? PRIVATE_PATH;
        }
      } else {
        await act(async () => {
          await pauseRealtimeDeliveries();
        });
        await waitFor(() =>
          expect(screen.getByRole('button', { name: UNAVAILABLE_LABEL })).toBeTruthy(),
        );
        expectUnavailableContact(view.toJSON());
        resumeRealtimeDeliveries();
        await renderWithTheme(
          <ContactCard
            att={localAttachment({ guid: SECOND_GUID, localPath: SECOND_PATH })}
            isFromMe={false}
          />,
        );
        expect(await screen.findByText(SECOND_NAME)).toBeTruthy();
        freshButtonName = `Contact: ${SECOND_NAME}`;
        freshPath = SECOND_PATH;
      }

      await act(async () => {
        if (rejects) nativeOpen.reject(result);
        else nativeOpen.resolve(result as { status: string });
        await nativeOpen.promise.catch(() => undefined);
      });

      expect(download).not.toHaveBeenCalled();
      expect(useToastStore.getState().current).toBeNull();
      expect(JSON.stringify(view.toJSON())).not.toContain('private-contact-revoked-error-aa-8eb1');
      if (_outcome === 'missing') {
        mockOpenAttachmentFile.mockResolvedValueOnce({ status: 'missing' });
      }
      const freshPress = retainConfiguredPress(
        screen.getByRole('button', { name: freshButtonName }),
      );
      await invokeConfiguredPress(freshPress);
      expect(mockOpenAttachmentFile).toHaveBeenCalledTimes(2);
      expect(mockOpenAttachmentFile).toHaveBeenNthCalledWith(2, freshPath, 'text/vcard');
      if (_outcome === 'missing') {
        await waitFor(() =>
          expect(download).toHaveBeenCalledWith(sourceA, 'manual', expect.any(Object)),
        );
        const originalLease = (download as jest.Mock).mock.calls[0]?.[2] as RealtimeDeliveryLease;
        expect(originalLease.isCurrent()).toBe(true);
      }
    },
  );

  it('keeps a fresh A open pending across A → B → A while the old A result and finally stay inert', async () => {
    const oldAOpen = deferred<{ status: string }>();
    const freshAOpen = deferred<{ status: string }>();
    mockVcfText = async (path) => (path === PRIVATE_PATH ? PRIVATE_VCARD : SECOND_VCARD);
    mockOpenAttachmentFile
      .mockReturnValueOnce(oldAOpen.promise)
      .mockReturnValueOnce(freshAOpen.promise);
    const sourceA = localAttachment();
    const sourceB = localAttachment({ guid: SECOND_GUID, localPath: SECOND_PATH });
    const view = await renderWithTheme(<ContactCard att={sourceA} isFromMe={false} />);
    const oldAPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
    );
    await invokeConfiguredPress(oldAPress);

    await view.rerender(<ContactCard att={sourceB} isFromMe={false} />);
    expect(await screen.findByText(SECOND_NAME)).toBeTruthy();
    await view.rerender(<ContactCard att={sourceA} isFromMe={false} />);
    const freshAPress = retainConfiguredPress(
      await screen.findByRole('button', { name: `Contact: ${PRIVATE_NAME}` }),
    );
    await invokeConfiguredPress(freshAPress);
    expect(mockOpenAttachmentFile).toHaveBeenNthCalledWith(2, PRIVATE_PATH, 'text/vcard');

    await act(async () => {
      oldAOpen.resolve({ status: 'no_handler' });
      await oldAOpen.promise;
    });
    expect(useToastStore.getState().current).toBeNull();
    await invokeConfiguredPress(freshAPress);
    expect(mockOpenAttachmentFile).toHaveBeenCalledTimes(2);

    await act(async () => {
      freshAOpen.resolve({ status: 'error' });
      await freshAOpen.promise;
    });
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('Couldn’t open this contact card'),
    );
  });
});
