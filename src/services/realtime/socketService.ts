import { io, type Socket } from 'socket.io-client';
import { SERVER_EVENTS } from '@core/config';
import { EventRouter, type EventSink } from '@core/realtime';
import { logger } from '@core/secure';

export interface SocketAuthOptions {
  /** Auth header(s) for the handshake (mirrors the REST client's headers). */
  headers?: Record<string, string>;
  /**
   * When true, send the password as a `?guid=` handshake query (what a stock/old
   * BlueBubbles server reads — `socket.handshake.query.guid`) instead of the secure
   * `auth` payload. Drive this from `HttpClient.usesHeaderAuth()` so REST and socket
   * stay in the same mode. Legacy mode puts the password in the (WSS-encrypted) URL,
   * so use it only against servers that don't support `handshake.auth`.
   */
  legacyQueryAuth?: boolean;
  /**
   * Optional URL-refresh hook for the reconnect escalation ladder. After socket.io's
   * built-in retries are exhausted we call this to (re)discover the server origin and
   * reconnect to the result (the Flutter app does this via `fdb.fetchNewUrl()`).
   *
   * NOTE: this is an OPTIONAL hook only. Nothing in `src/` wires it yet — the Firebase
   * `ServerUrlResolver.refresh()` that would supply a fresh origin is not built at the
   * composition root, so today the escalation just reconnects to the SAME origin (a
   * clean no-op when the hook is omitted). Pass a resolver here to enable rediscovery.
   */
  refreshUrl?: () => Promise<string | null>;
}

// ── Reconnect escalation (Phase 1.1) ──────────────────────────────────────────
// socket.io does quick built-in retries, but we cap them (`reconnectionAttempts`) so it
// SURRENDERS to our app-level ladder instead of retrying forever. ON TOP of socket.io,
// once the manager reports `reconnect_failed` (i.e. those capped retries are exhausted),
// we wait a capped-exponential backoff, optionally refresh the server URL, then restart
// the socket. (With socket.io's default `reconnectionAttempts: Infinity`, that event
// would never fire and this whole ladder would be dead code.)

/**
 * How many built-in reconnect attempts socket.io makes before it gives up and emits
 * `reconnect_failed` — at which point our app-level escalation ladder takes over. This
 * MUST be finite (socket.io defaults it to Infinity); otherwise `reconnect_failed`
 * never fires and the escalation below is unreachable.
 */
const SOCKET_RECONNECTION_ATTEMPTS = 5;
/** Ceiling for socket.io's own per-attempt backoff (its ladder, not ours). */
const SOCKET_RECONNECTION_DELAY_MAX_MS = 10_000;
/** Base delay for the escalation backoff. */
const SOCKET_BACKOFF_BASE_MS = 1_000;
/** Hard ceiling for the escalation backoff. */
const SOCKET_BACKOFF_MAX_MS = 60_000;
/** Window within which a duplicate socket-error signature is suppressed. */
const SOCKET_ERROR_THROTTLE_MS = 60_000;

/**
 * Capped exponential backoff (with jitter) for the app-level reconnect escalation.
 *
 * Pure + deterministic given `attempt` and `rand` (injectable so it's node-testable):
 * `min(base * 2^attempt, max)` plus up to 10% positive jitter to de-synchronize many
 * clients reconnecting at once. `attempt` is 0-based (0 → ~1s, 1 → ~2s, … capped ~60s).
 */
export function nextSocketBackoffMs(attempt: number, rand: () => number = Math.random): number {
  const safe = Math.max(0, Math.floor(attempt));
  const exp = SOCKET_BACKOFF_BASE_MS * 2 ** safe;
  const capped = Math.min(exp, SOCKET_BACKOFF_MAX_MS);
  // Small positive jitter (0–10%) so a fleet of clients doesn't reconnect in lockstep.
  const jitter = capped * 0.1 * rand();
  return Math.round(capped + jitter);
}

/** A socket-error fingerprint: same host + code + message ⇒ the "same" error. */
export interface SocketErrorSignature {
  host: string;
  code: string;
  message: string;
}

/** Serialize a signature into the Map key used for throttling. */
export function socketErrorKey(sig: SocketErrorSignature): string {
  return `${sig.host}|${sig.code}|${sig.message}`;
}

/**
 * Throttle decision for socket-error logging (Phase 1.2). Pure + node-testable.
 *
 * Returns true (→ log it, and the caller must record `now` for this key) when the
 * signature has not been logged within the last {@link SOCKET_ERROR_THROTTLE_MS}.
 * A repeat inside the window returns false (suppress); the next occurrence after the
 * window elapses logs again. `lastSeen` maps signature key → last-logged epoch ms.
 *
 * @param sig the (host, code, message) fingerprint
 * @param now current epoch ms
 * @param lastSeen mutable map of key → last-logged ms (NOT mutated here — caller records)
 */
export function shouldLogSocketError(
  sig: SocketErrorSignature,
  now: number,
  lastSeen: Map<string, number>,
): boolean {
  const last = lastSeen.get(socketErrorKey(sig));
  if (last === undefined) return true;
  return now - last >= SOCKET_ERROR_THROTTLE_MS;
}

/**
 * Socket.IO connection for live updates while the app is open. By default auth
 * travels in the handshake `auth` payload (not the URL query — the security fix);
 * legacy mode falls back to a `?guid=` query for servers that only read it. Every
 * server event is funneled through the EventRouter into the injected sink (DB sink).
 *
 * On Android, FCM is the primary delivery path (Phase 6); this covers the
 * foreground/open window.
 *
 * Robustness (Phase 1.1/1.2): on top of socket.io's quick built-in retries, an
 * app-level escalation refreshes the server URL and restarts the socket on a capped
 * exponential backoff, and duplicate error logs are throttled to one per minute.
 */
export class SocketService {
  private socket: Socket | null = null;
  private readonly router: EventRouter;

  // Escalation state.
  private origin = '';
  private password = '';
  private opts: SocketAuthOptions = {};
  private escalationAttempt = 0;
  private escalationTimer: ReturnType<typeof setTimeout> | null = null;
  private escalationInProgress = false;
  private stopped = false;

  // Error-log throttling state: signature key → last-logged epoch ms.
  private readonly lastErrorLoggedAt = new Map<string, number>();

  constructor(sink: EventSink) {
    this.router = new EventRouter(sink);
  }

  connect(origin: string, password: string, opts: SocketAuthOptions = {}): void {
    this.disconnect();
    this.stopped = false;
    this.origin = origin;
    this.password = password;
    this.opts = opts;
    this.openSocket();
  }

  /** (Re)open the underlying socket against the current origin/password/opts. */
  private openSocket(): void {
    this.socket = io(this.origin, {
      transports: ['websocket'],
      // Secure default: auth payload. Legacy: `guid` query for stock servers.
      ...(this.opts.legacyQueryAuth
        ? { query: { guid: this.password } }
        : { auth: { password: this.password } }),
      extraHeaders: this.opts.headers ?? {},
      reconnection: true,
      // Cap socket.io's built-in retries (its default is Infinity) so it surrenders to
      // our app-level escalation ladder: after this many failed attempts the Manager
      // emits `reconnect_failed`, which triggers scheduleEscalation() below.
      reconnectionAttempts: SOCKET_RECONNECTION_ATTEMPTS,
      reconnectionDelayMax: SOCKET_RECONNECTION_DELAY_MAX_MS,
    });
    for (const event of SERVER_EVENTS) {
      this.socket.on(event, (data: unknown) => {
        void this.router.handle(event, data, 'socket');
      });
    }

    // A clean (re)connect resets the escalation ladder and the suppression window.
    this.socket.on('connect', () => {
      this.escalationAttempt = 0;
      this.cancelEscalation();
      this.lastErrorLoggedAt.clear();
    });

    // Per-attempt connect failures: throttled logging only (socket.io keeps retrying).
    this.socket.on('connect_error', (err: unknown) => {
      this.logSocketError(err);
    });

    // socket.io exhausted its built-in retries → take over with URL-refresh escalation.
    // The Manager (`socket.io`) emits `reconnect_failed`; guard access since a test stub
    // may not expose it. Fall back to the socket-level `error` event otherwise.
    const manager = (this.socket as { io?: { on?: (e: string, cb: () => void) => void } }).io;
    if (manager?.on) {
      manager.on('reconnect_failed', () => this.scheduleEscalation());
    }
    this.socket.on('error', (err: unknown) => {
      this.logSocketError(err);
    });
  }

  /** Build a (host, code, message) signature from an arbitrary socket error value. */
  private errorSignature(err: unknown): SocketErrorSignature {
    let host = '';
    try {
      host = new URL(this.origin).host;
    } catch {
      host = this.origin;
    }
    let code = '';
    let message = '';
    if (err instanceof Error) {
      message = err.message;
      // socket.io connect errors often carry a numeric/string `code` on the Error.
      const maybeCode = (err as { code?: unknown }).code;
      if (maybeCode != null) code = String(maybeCode);
    } else if (typeof err === 'string') {
      message = err;
    } else if (err != null) {
      message = String(err);
    }
    return { host, code, message };
  }

  /** Log a socket error through the redacting logger, throttled by signature (60s window). */
  private logSocketError(err: unknown): void {
    const sig = this.errorSignature(err);
    const now = Date.now();
    if (!shouldLogSocketError(sig, now, this.lastErrorLoggedAt)) return;
    this.lastErrorLoggedAt.set(socketErrorKey(sig), now);
    logger.error(`[socket] error connecting to ${sig.host}: ${sig.message || 'unknown error'}`);
  }

  /**
   * Schedule the app-level reconnect escalation after socket.io gave up: wait a capped
   * exponential backoff, refresh the server URL, then restart the socket. Idempotent —
   * a pending/in-progress escalation is not re-scheduled.
   */
  private scheduleEscalation(): void {
    if (this.stopped || this.escalationTimer != null || this.escalationInProgress) return;
    const delay = nextSocketBackoffMs(this.escalationAttempt);
    this.escalationAttempt += 1;
    logger.warn(
      `[socket] reconnect attempts exhausted — refreshing URL + restarting in ${delay}ms`,
    );
    this.escalationTimer = setTimeout(() => {
      this.escalationTimer = null;
      void this.runEscalation();
    }, delay);
  }

  /** Refresh the server URL (if a hook is provided) and restart the socket. */
  private async runEscalation(): Promise<void> {
    if (this.stopped || this.socket?.connected) return;
    this.escalationInProgress = true;
    try {
      if (this.opts.refreshUrl) {
        // TODO(phase1): wire `refreshUrl` to the Firebase ServerUrlResolver.refresh() at the
        // composition root (src/services/index.ts) so a moved server is rediscovered here.
        const fresh = await this.opts.refreshUrl();
        if (fresh && fresh !== this.origin) {
          logger.info('[socket] server URL changed — reconnecting to the new origin');
          this.origin = fresh;
        }
      }
      // Restart against the (possibly new) origin.
      this.teardownSocket();
      if (!this.stopped) this.openSocket();
    } catch (e) {
      this.logSocketError(e);
    } finally {
      this.escalationInProgress = false;
    }
  }

  private cancelEscalation(): void {
    if (this.escalationTimer != null) {
      clearTimeout(this.escalationTimer);
      this.escalationTimer = null;
    }
  }

  /** Tear down the current socket instance (without touching escalation state). */
  private teardownSocket(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  /** Emit an event to the server (e.g. started/stopped-typing). No-op if disconnected. */
  emit(event: string, payload?: unknown): void {
    this.socket?.emit(event, payload);
  }

  disconnect(): void {
    this.stopped = true;
    this.cancelEscalation();
    this.escalationAttempt = 0;
    this.escalationInProgress = false;
    this.lastErrorLoggedAt.clear();
    this.teardownSocket();
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
}
