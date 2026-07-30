/**
 * Report an attachment upload's byte progress to a sink for the duration of ONE attempt.
 *
 * PURE (no expo imports) for exactly the reason `uploadErrors.ts` is: `attachmentUpload.ts`
 * imports `expo-file-system` and therefore cannot be loaded in the node jest project at all — but
 * the part that must not break can be tested here.
 *
 * What must not break is the SETTLE. The sink entry is what draws the spinner on the bubble and
 * what keeps the composer's upload bar on screen, so an entry that is started and never settled
 * is not a cosmetic glitch: it is a permanent phantom "sending" for a message that finished (or
 * failed) minutes ago, with no way for the user to clear it. Hence the `finally`.
 */

export interface UploadStartInfo {
  chatGuid: string;
  /** File name, for the status bar's single-file readout. */
  name: string;
  /** Byte size if known up front, else 0 — the native uploader reports the real one shortly. */
  total: number;
}

export interface UploadProgressSink {
  start(key: string, info: UploadStartInfo): void;
  progress(key: string, sent: number, total: number): void;
  settle(key: string): void;
}

/** A sink that reports nowhere — for callers with no UI to update (and for tests). */
export const nullUploadSink: UploadProgressSink = {
  start: () => {},
  progress: () => {},
  settle: () => {},
};

/**
 * Run `run` as a tracked upload: open an entry under `key`, forward every byte update to the
 * sink, and settle the entry however the attempt ends (resolve, reject, or cancel).
 *
 * `key` is the ATTACHMENT guid, not the message temp guid — that is what the attachment
 * components render under, so the ring lands on the right bubble.
 */
export async function runTrackedUpload<T>(
  sink: UploadProgressSink,
  key: string,
  info: UploadStartInfo,
  run: (onProgress: (sent: number, total: number) => void) => Promise<T>,
): Promise<T> {
  sink.start(key, info);
  try {
    return await run((sent, total) => sink.progress(key, sent, total));
  } finally {
    sink.settle(key);
  }
}
