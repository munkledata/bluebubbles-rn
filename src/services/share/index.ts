export type { ShareFileIO } from './materializeShare';
export { materializeSharedFiles, pruneShareCache } from './materializeShare';
export { parseRawShareEvent } from './shareIntentPayload';
export type { ParsedShare, RawShareFile, ShareSource } from './shareIntentPayload';
export { createShareCapture } from './captureShare';

/**
 * IPC-01 containment: this barrel intentionally exports only injected, testable building blocks.
 * There is no production native binding. `expo-share-intent@8.0.1` performs unbounded provider I/O
 * before its JavaScript event, so app config and the root layout keep all inbound sharing disabled
 * until an owned native module can enforce count, byte, aggregate, cancellation, and time limits
 * while it streams.
 */
