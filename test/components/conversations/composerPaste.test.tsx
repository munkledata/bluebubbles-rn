/**
 * Composer ← pasted pictures/files (src/ui/conversations/Composer.tsx + src/services/paste/).
 *
 * The native half (`modules/gator-paste-input/`, a Kotlin `OnReceiveContentListener`) cannot run
 * under Jest, so this suite locks in the JS contract around it — the part that has historically
 * been where these bridges silently break:
 *   - the listener is registered with a NUMERIC React tag. This is the regression guard that
 *     matters most: Expo's ref converter reads `nativeTag`, but RN 0.86's Fabric public instances
 *     expose `__nativeTag`, so handing over the ref object itself resolves to nothing and paste
 *     dies silently on device while every test still passes;
 *   - registration happens on the input's LAYOUT, not on mount (the native lookup goes through the
 *     UIManager's mounting layer, which has nothing to find before the Fabric mount lands);
 *   - a pasted file is staged like any other attachment and rides the normal send path;
 *   - a re-paste of the same uri does not double-stage;
 *   - a paste whose files were all unusable says so, instead of appearing to do nothing;
 *   - unmount tears the native registration down.
 *
 * In-file mocks:
 *   - `react-native/.../RendererProxy`: `findNodeHandle` genuinely returns null under the test
 *     renderer (verified), so without this the tag is never captured and there is nothing to test.
 *     `react-native`'s own `findNodeHandle` is a lazy getter over this module, so mocking here
 *     avoids mocking all of react-native.
 *   - `@/services/paste`: stands in for the native module, and exposes the paste callback so a
 *     paste can be driven from the test.
 *   - `@ui/conversations/AttachmentTray`, `expo-image`, `@expo/vector-icons`,
 *     `react-native-safe-area-context`: native-pulling siblings, stubbed exactly as in
 *     composer.test.tsx.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act, waitFor } from '../support/renderWithTheme';

const FAKE_TAG = 4242;

// findNodeHandle returns null under react-test-renderer; give the composer a real tag to attach to.
jest.mock('react-native/Libraries/ReactNative/RendererProxy', () => ({
  ...jest.requireActual('react-native/Libraries/ReactNative/RendererProxy'),
  findNodeHandle: jest.fn(() => 4242),
}));

// Stand-in for the native paste module: records the attach call and hands the test the callback.
// The `mock` prefix is required — jest.mock factories may only close over such names.
const mockPaste: {
  attach: jest.Mock;
  unsubscribe: jest.Mock;
  fire: ((result: { files: unknown[]; dropped: number }) => void) | null;
} = { attach: jest.fn(), unsubscribe: jest.fn(), fire: null };

jest.mock('@/services/paste', () => ({
  attachPasteListener: (
    tag: number,
    onPaste: (r: { files: unknown[]; dropped: number }) => void,
  ) => {
    mockPaste.attach(tag);
    mockPaste.fire = onPaste;
    return mockPaste.unsubscribe;
  },
  isPasteInputAvailable: () => true,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

jest.mock('expo-image', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => React.createElement(View, props) };
});

jest.mock('@react-native-community/datetimepicker', () => ({
  DateTimePickerAndroid: { open: jest.fn() },
}));

jest.mock('@ui/conversations/AttachmentTray', () => ({
  ATTACHMENT_TRAY_HEIGHT: 104,
  AttachmentTray: () => null,
}));

// eslint-disable-next-line import/first
import { Composer } from '@ui/conversations/Composer';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';

const PASTED_IMAGE = {
  uri: 'file:///cache/pasted-in/1/shot.png',
  name: 'shot.png',
  mimeType: 'image/png',
  size: 4096,
};
const PASTED_PDF = {
  uri: 'file:///cache/pasted-in/1/invoice.pdf',
  name: 'invoice.pdf',
  mimeType: 'application/pdf',
  size: 9000,
};

/** Render the composer and fire the input's layout, which is what registers the paste listener. */
async function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = jest.fn();
  const onSendAttachments = jest.fn();
  const view = await renderWithTheme(
    <Composer onSend={onSend} onSendAttachments={onSendAttachments} {...props} />,
  );
  return { ...view, onSend, onSendAttachments };
}

async function fireInputLayout(): Promise<void> {
  const input = screen.getByPlaceholderText('iMessage');
  await act(async () => {
    fireEvent(input, 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 200, height: 38 } },
    });
  });
}

beforeEach(() => {
  mockPaste.attach.mockClear();
  mockPaste.unsubscribe.mockClear();
  mockPaste.fire = null;
  useToastStore.setState({ current: null, queue: [] });
});

describe('Composer paste', () => {
  it('registers the native listener with a NUMERIC tag, not the ref object', async () => {
    await renderComposer();
    await fireInputLayout();

    await waitFor(() => expect(mockPaste.attach).toHaveBeenCalled());
    const tag = mockPaste.attach.mock.calls[0]?.[0];
    expect(typeof tag).toBe('number');
    expect(tag).toBe(FAKE_TAG);
  });

  it('does not register before the input has laid out', async () => {
    await renderComposer();
    expect(mockPaste.attach).not.toHaveBeenCalled();
  });

  it('stages a pasted image as an attachment', async () => {
    await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.fire).not.toBeNull());

    await act(async () => {
      mockPaste.fire?.({ files: [PASTED_IMAGE], dropped: 0 });
    });

    expect(await screen.findByLabelText('Remove attachment')).toBeTruthy();
  });

  it('stages a pasted PDF too — paste is not images-only', async () => {
    const { onSendAttachments } = await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.fire).not.toBeNull());

    await act(async () => {
      mockPaste.fire?.({ files: [PASTED_PDF], dropped: 0 });
    });
    await screen.findByLabelText('Remove attachment');

    fireEvent.press(screen.getByLabelText('Send message'));
    await waitFor(() => expect(onSendAttachments).toHaveBeenCalledWith([PASTED_PDF]));
  });

  it('sends a pasted file through the normal attachment path, alongside typed text', async () => {
    const { onSend, onSendAttachments } = await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.fire).not.toBeNull());

    await act(async () => {
      mockPaste.fire?.({ files: [PASTED_IMAGE], dropped: 0 });
    });
    fireEvent.changeText(screen.getByPlaceholderText('iMessage'), 'look at this');
    await waitFor(() => expect(screen.getByLabelText('Send message')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Send message'));
    await waitFor(() => expect(onSendAttachments).toHaveBeenCalledWith([PASTED_IMAGE]));
    expect(onSend).toHaveBeenCalledWith('look at this', undefined, undefined, undefined);
  });

  it('stages several files from one paste', async () => {
    await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.fire).not.toBeNull());

    await act(async () => {
      mockPaste.fire?.({ files: [PASTED_IMAGE, PASTED_PDF], dropped: 0 });
    });

    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(2));
  });

  it('does not double-stage the same uri', async () => {
    await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.fire).not.toBeNull());

    await act(async () => {
      mockPaste.fire?.({ files: [PASTED_IMAGE], dropped: 0 });
    });
    await screen.findByLabelText('Remove attachment');
    await act(async () => {
      mockPaste.fire?.({ files: [PASTED_IMAGE], dropped: 0 });
    });

    await waitFor(() => expect(screen.getAllByLabelText('Remove attachment')).toHaveLength(1));
  });

  it('tells the user when a paste yielded nothing usable', async () => {
    await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.fire).not.toBeNull());

    await act(async () => {
      mockPaste.fire?.({ files: [], dropped: 1 });
    });

    expect(useToastStore.getState().current?.message).toMatch(/couldn't read/i);
    expect(screen.queryByLabelText('Remove attachment')).toBeNull();
  });

  it('stays silent when a paste staged files successfully', async () => {
    await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.fire).not.toBeNull());

    await act(async () => {
      mockPaste.fire?.({ files: [PASTED_IMAGE], dropped: 0 });
    });

    expect(useToastStore.getState().current).toBeNull();
  });

  it('tears the native registration down on unmount', async () => {
    const view = await renderComposer();
    await fireInputLayout();
    await waitFor(() => expect(mockPaste.attach).toHaveBeenCalled());

    await act(async () => {
      view.unmount();
    });

    expect(mockPaste.unsubscribe).toHaveBeenCalled();
  });
});
