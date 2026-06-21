import { io, type Socket } from 'socket.io-client';
import { SERVER_EVENTS } from '@core/config';
import { EventRouter, type EventSink } from '@core/realtime';

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
}

/**
 * Socket.IO connection for live updates while the app is open. By default auth
 * travels in the handshake `auth` payload (not the URL query — the security fix);
 * legacy mode falls back to a `?guid=` query for servers that only read it. Every
 * server event is funneled through the EventRouter into the injected sink (DB sink).
 *
 * On Android, FCM is the primary delivery path (Phase 6); this covers the
 * foreground/open window.
 */
export class SocketService {
  private socket: Socket | null = null;
  private readonly router: EventRouter;

  constructor(sink: EventSink) {
    this.router = new EventRouter(sink);
  }

  connect(origin: string, password: string, opts: SocketAuthOptions = {}): void {
    this.disconnect();
    this.socket = io(origin, {
      transports: ['websocket'],
      // Secure default: auth payload. Legacy: `guid` query for stock servers.
      ...(opts.legacyQueryAuth ? { query: { guid: password } } : { auth: { password } }),
      extraHeaders: opts.headers ?? {},
      reconnection: true,
    });
    for (const event of SERVER_EVENTS) {
      this.socket.on(event, (data: unknown) => {
        void this.router.handle(event, data, 'socket');
      });
    }
  }

  /** Emit an event to the server (e.g. started/stopped-typing). No-op if disconnected. */
  emit(event: string, payload?: unknown): void {
    this.socket?.emit(event, payload);
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }
}
