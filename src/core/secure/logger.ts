import { RedactingLogger, type LogLevel, type LogSink } from './redact';

/**
 * Console sink for the app-wide logger. Redaction already happened upstream in
 * {@link RedactingLogger}, so this just routes to the right console method.
 * `debug` is suppressed in production builds (kept quiet, never to a release log).
 */
export class ConsoleSink implements LogSink {
  write(level: LogLevel, message: string, meta?: unknown): void {
    // `__DEV__` is a RN runtime global; guard `typeof` since it's undefined under Jest.
    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    if (level === 'debug' && !isDev) return;
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (meta === undefined) out(message);
    else out(message, meta);
  }
}

/**
 * The app-wide logger. EVERY message + meta object is scrubbed (guid / password /
 * token / fcmtoken / authorization keys, and `?guid=`-style URL params) before it
 * reaches any sink. Use this instead of `console.*` everywhere so nothing sensitive
 * can leak to logcat / a release log / a future Sentry breadcrumb.
 *
 * To add Sentry later: wrap this sink (or add a second one) that forwards the
 * already-redacted message as a breadcrumb — see RELEASE_CHECKLIST §9.2.
 */
export const logger = new RedactingLogger(new ConsoleSink());
