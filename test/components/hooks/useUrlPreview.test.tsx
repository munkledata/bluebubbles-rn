import { act, renderHook, waitFor } from '../support/renderWithTheme';
import { ServerInfo } from '@core/models';
import { getUrlPreview, type UrlPreviewRow } from '@db/repositories';
import {
  URL_PREVIEW_NEGATIVE_TTL_MS,
  URL_PREVIEW_SUCCESS_TTL_MS,
} from '@db/repositories/urlPreviews';
import { useUrlPreview } from '@features/conversations/useUrlPreview';
import { useSessionStore } from '@state/sessionStore';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { readUrlPreviewAndLoad } from '@/services/urlPreviewLoader';

jest.mock('@db/repositories', () => ({ getUrlPreview: jest.fn() }));
jest.mock('@/services/urlPreviewLoader', () => ({ readUrlPreviewAndLoad: jest.fn() }));

const URL = 'https://example.com/article';
const CACHED: UrlPreviewRow = {
  url: URL,
  title: 'Cached title',
  description: 'Cached description',
  imageUrl: null,
  siteName: 'Example',
  fetchedAt: 1_000,
  error: 0,
};

const mockGetUrlPreview = getUrlPreview as jest.MockedFunction<typeof getUrlPreview>;
const mockReadUrlPreviewAndLoad = readUrlPreviewAndLoad as jest.MockedFunction<
  typeof readUrlPreviewAndLoad
>;

function connect(
  accountEpoch: number,
  transportRevision: number,
  supportsPreviewProxy: boolean,
): void {
  useSessionStore.setState({
    status: 'connected',
    epoch: accountEpoch,
    transportRevision,
    serverInfo: ServerInfo.parse({
      version: '2.0.0',
      supports_url_preview_proxy: supportsPreviewProxy,
    }),
  });
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  connect(10, 20, true);
  const fresh = { ...CACHED, fetchedAt: Date.now() };
  mockGetUrlPreview.mockResolvedValue(fresh);
  mockReadUrlPreviewAndLoad.mockResolvedValue(fresh);
});

afterEach(() => {
  jest.useRealTimers();
  resumeRealtimeDeliveries();
});

describe('useUrlPreview', () => {
  it('uses only the local cache when the connected server lacks the proxy capability', async () => {
    connect(10, 20, false);
    const { result } = await renderHook(() => useUrlPreview(URL));

    await waitFor(() => expect(result.current?.title).toBe('Cached title'));
    expect(mockGetUrlPreview).toHaveBeenCalledWith(undefined, URL);
    expect(mockReadUrlPreviewAndLoad).not.toHaveBeenCalled();
  });

  it('passes the render-owned account and current transport to the capable loader', async () => {
    const { result } = await renderHook(() => useUrlPreview(URL));

    await waitFor(() => expect(result.current?.title).toBe('Cached title'));
    expect(mockReadUrlPreviewAndLoad).toHaveBeenCalledWith(URL, {
      accountEpoch: 10,
      transportRevision: 20,
    });
    expect(mockGetUrlPreview).not.toHaveBeenCalled();
  });

  it('immediately hides account A metadata and never adopts B in a stale mounted hook', async () => {
    const { result, rerender } = await renderHook(() => useUrlPreview(URL));
    await waitFor(() => expect(result.current?.title).toBe('Cached title'));

    await act(async () => {
      await pauseRealtimeDeliveries();
      connect(11, 21, true);
      resumeRealtimeDeliveries();
    });

    expect(result.current).toBeNull();
    await act(async () => rerender(undefined));
    expect(result.current).toBeNull();
    expect(mockReadUrlPreviewAndLoad).toHaveBeenCalledTimes(1);
    expect(mockReadUrlPreviewAndLoad).not.toHaveBeenCalledWith(URL, {
      accountEpoch: 11,
      transportRevision: 21,
    });
  });

  it('hides a mounted positive row at 24 hours and re-reads without a table write', async () => {
    const now = 100_000;
    jest.useFakeTimers({ now });
    connect(10, 20, false);
    mockGetUrlPreview.mockResolvedValue({ ...CACHED, fetchedAt: now });
    const { result } = await renderHook(() => useUrlPreview(URL));

    await waitFor(() => expect(result.current?.title).toBe('Cached title'));

    await act(async () => {
      jest.advanceTimersByTime(URL_PREVIEW_SUCCESS_TTL_MS);
      await Promise.resolve();
    });

    expect(Date.now()).toBeGreaterThanOrEqual(now + URL_PREVIEW_SUCCESS_TTL_MS);
    await waitFor(() => expect(mockGetUrlPreview).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current).toBeNull());
  });

  it('retries a mounted negative row after 15 minutes without a table write', async () => {
    const now = 200_000;
    jest.useFakeTimers({ now });
    const negative = { ...CACHED, title: null, description: null, error: 1, fetchedAt: now };
    mockReadUrlPreviewAndLoad.mockResolvedValue(negative);
    const { result } = await renderHook(() => useUrlPreview(URL));

    await waitFor(() => expect(result.current?.error).toBe(1));

    await act(async () => {
      jest.advanceTimersByTime(URL_PREVIEW_NEGATIVE_TTL_MS);
      await Promise.resolve();
    });

    expect(Date.now()).toBeGreaterThanOrEqual(now + URL_PREVIEW_NEGATIVE_TTL_MS);
    await waitFor(() => expect(mockReadUrlPreviewAndLoad).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current).toBeNull());
  });

  it('never displays an already-expired row from a legacy server', async () => {
    const now = 300_000;
    jest.useFakeTimers({ now });
    connect(10, 20, false);
    mockGetUrlPreview.mockResolvedValue({
      ...CACHED,
      fetchedAt: now - URL_PREVIEW_SUCCESS_TTL_MS,
    });
    const { result } = await renderHook(() => useUrlPreview(URL));

    await act(async () => Promise.resolve());

    expect(result.current).toBeNull();
    expect(mockGetUrlPreview).toHaveBeenCalledTimes(1);
  });
});
