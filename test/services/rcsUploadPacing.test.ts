import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import {
  createRcsPacedUploader,
  createRcsShareUploader,
  isRcsDispatchBusy,
  RCS_BUSY_MAX_RESENT_BYTES,
} from '@/services/send/rcsUploadPacing';
import type { AttachmentUploader } from '@/services/send/sendAttachmentService';
import { createConcurrencyGate, createUploadRegistry } from '@/services/send/uploadControl';

// Owner phone session 2026-10-21: four files shared at once into an RCS chat; the server hands one
// RCS media file to Google at a time and refused the other three with a retryable 503
// `rcs_dispatch_busy`, which Gator showed as failures.

type UploadArgs = Parameters<AttachmentUploader>[0];

const ack = { guid: 'temp-1' } as unknown as Awaited<ReturnType<AttachmentUploader>>;
const busy = (): ApiError =>
  ApiError.fromStatus(503, 'attachment upload failed', undefined, 'rcs_dispatch_busy');

function argsFor(tempGuid: string, extra: Partial<UploadArgs> = {}): UploadArgs {
  return {
    http: {} as HttpClient,
    chatGuid: 'RCS;-;+15550001111',
    tempGuid,
    attachmentGuid: `att-${tempGuid}`,
    name: 'photo.png',
    uri: 'file:///photo.png',
    mimeType: 'image/png',
    ...extra,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A clock that only moves when the paced uploader sleeps, so waits are exact and instant. */
function fakeClock(): {
  now: () => number;
  sleep: jest.Mock<Promise<void>, [number, AbortSignal?]>;
} {
  let time = 1_000_000;
  const sleep = jest.fn(async (ms: number) => {
    time += ms;
  });
  return { now: () => time, sleep };
}

describe('RCS upload pacing', () => {
  it('recognizes only the typed RCS-busy refusal', () => {
    expect(isRcsDispatchBusy(busy())).toBe(true);
    expect(
      isRcsDispatchBusy(
        ApiError.fromStatus(503, 'attachment upload failed', undefined, 'bridge_unavailable'),
      ),
    ).toBe(false);
    expect(isRcsDispatchBusy(ApiError.fromStatus(500, 'attachment upload failed'))).toBe(false);
    expect(isRcsDispatchBusy(new Error('rcs_dispatch_busy'))).toBe(false);
  });

  it('retries a busy RCS upload after a short wait and returns the server ack', async () => {
    const clock = fakeClock();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>();
    upload.mockRejectedValueOnce(busy()).mockResolvedValueOnce(ack);
    const paced = createRcsPacedUploader(upload, { ...clock, random: () => 0.5 });

    await expect(paced(argsFor('temp-1'))).resolves.toBe(ack);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]![0].tempGuid).toBe('temp-1');
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep.mock.calls[0]![0]).toBe(2_000);
  });

  it('never retries any other failure', async () => {
    const clock = fakeClock();
    const failure = ApiError.fromStatus(503, 'attachment upload failed', undefined, 'other_type');
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      throw failure;
    });
    const paced = createRcsPacedUploader(upload, { ...clock, random: () => 0.5 });

    await expect(paced(argsFor('temp-1'))).rejects.toBe(failure);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('leaves iMessage uploads alone: no retry and no waiting behind RCS files', async () => {
    const clock = fakeClock();
    let finishRcs!: () => void;
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async (args) => {
      if (args.service === 'iMessage') throw busy();
      await new Promise<void>((resolve) => {
        finishRcs = resolve;
      });
      return ack;
    });
    const paced = createRcsPacedUploader(upload, {
      ...clock,
      gate: createConcurrencyGate(1),
      random: () => 0.5,
    });

    const rcs = paced(argsFor('rcs-1'));
    await Promise.resolve();
    // The RCS upload holds the RCS slot; an iMessage upload still starts at once and is not retried.
    await expect(paced(argsFor('imessage-1', { service: 'iMessage' }))).rejects.toMatchObject({
      status: 503,
    });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(clock.sleep).not.toHaveBeenCalled();

    finishRcs();
    await expect(rcs).resolves.toBe(ack);
  });

  it('sends RCS files one at a time, in the order they were started', async () => {
    const clock = fakeClock();
    const started: string[] = [];
    const finishers = new Map<string, () => void>();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async (args) => {
      started.push(args.tempGuid);
      await new Promise<void>((resolve) => finishers.set(args.tempGuid, resolve));
      return ack;
    });
    const paced = createRcsPacedUploader(upload, {
      ...clock,
      gate: createConcurrencyGate(1),
      random: () => 0.5,
    });

    const first = paced(argsFor('a'));
    const second = paced(argsFor('b'));
    const third = paced(argsFor('c'));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(started).toEqual(['a']);

    finishers.get('a')!();
    await first;
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(started).toEqual(['a', 'b']);

    finishers.get('b')!();
    await second;
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    finishers.get('c')!();
    await third;
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('stops without another upload when the send is cancelled during the wait', async () => {
    const controller = new AbortController();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      throw busy();
    });
    const sleep = jest.fn(
      (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new ApiError('cancelled', 'Attachment upload was cancelled')),
          );
        }),
    );
    const paced = createRcsPacedUploader(upload, { sleep, now: () => 0, random: () => 0.5 });

    const pending = paced(argsFor('temp-1', { signal: controller.signal }));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('never opens a queued RCS upload that is cancelled before its turn', async () => {
    const clock = fakeClock();
    let finishFirst!: () => void;
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      return ack;
    });
    const gate = createConcurrencyGate(1);
    const paced = createRcsPacedUploader(upload, { ...clock, gate, random: () => 0.5 });
    const controller = new AbortController();

    const first = paced(argsFor('first'));
    const queued = paced(argsFor('queued', { signal: controller.signal }));
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    controller.abort();

    await expect(queued).rejects.toMatchObject({ kind: 'cancelled' });
    finishFirst();
    await first;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(gate.active).toBe(0);
  });

  it('keeps each file registered while queued or waiting, so the retry drain leaves it alone', async () => {
    const registry = createUploadRegistry();
    let resumeSleep!: () => void;
    const sleep = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resumeSleep = resolve;
        }),
    );
    let finishB!: () => void;
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async (args) => {
      const attemptsForA = upload.mock.calls.filter(([call]) => call.tempGuid === 'a').length;
      if (args.tempGuid === 'a' && attemptsForA === 1) throw busy();
      if (args.tempGuid === 'b') {
        await new Promise<void>((resolve) => {
          finishB = resolve;
        });
      }
      return ack;
    });
    const paced = createRcsPacedUploader(upload, {
      gate: createConcurrencyGate(1),
      registry,
      sleep,
      now: () => 0,
      random: () => 0.5,
    });

    const a = paced(argsFor('a'));
    const b = paced(argsFor('b'));
    await settle();
    // 'a' waits to retry a busy refusal and 'b' is queued behind it: neither has a live socket,
    // yet both stay registered, so the retry drain cannot start a second attempt of either.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(true);

    resumeSleep();
    await expect(a).resolves.toBe(ack);
    expect(registry.has('a')).toBe(false);
    await settle();
    finishB();
    await expect(b).resolves.toBe(ack);
    expect(registry.has('b')).toBe(false);
  });

  it('stops a waiting file on Cancel Sending without opening another upload', async () => {
    const registry = createUploadRegistry();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      throw busy();
    });
    const sleep = jest.fn(
      (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new ApiError('cancelled', 'Attachment upload was cancelled')),
          );
        }),
    );
    const paced = createRcsPacedUploader(upload, {
      registry,
      sleep,
      now: () => 0,
      random: () => 0.5,
    });

    const pending = paced(argsFor('a'));
    await settle();
    expect(registry.cancel('a')).toBe(true);

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('keeps every retry inside the caller time limit', async () => {
    const clock = fakeClock();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      throw busy();
    });
    const paced = createRcsPacedUploader(upload, { ...clock, random: () => 0.5 });

    await expect(paced(argsFor('temp-1', { timeoutMs: 10_000 }))).rejects.toMatchObject({
      status: 503,
    });

    // 2 s then 4 s fit inside 10 s; the next 8 s wait would pass the limit, so it reports the busy
    // failure instead. Each attempt is handed only the time that is left.
    expect(upload.mock.calls.map(([args]) => args.timeoutMs)).toEqual([10_000, 8_000, 4_000]);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000]);
  });

  it('gives up after four busy retries and reports the failure as before', async () => {
    const clock = fakeClock();
    // Busy for ten attempts: a missing limit would resolve on the eleventh instead of failing.
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      if (upload.mock.calls.length > 10) return ack;
      throw busy();
    });
    const paced = createRcsPacedUploader(upload, { ...clock, random: () => 0.5 });

    await expect(paced(argsFor('temp-1'))).rejects.toMatchObject({ status: 503 });

    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000, 8_000, 15_000]);
    expect(upload).toHaveBeenCalledTimes(5);
  });

  // Step 1 review: a file that waited its turn behind a long share must still get its retries.
  it('counts retries from when the file gets its turn, not from when it was queued', async () => {
    const clock = fakeClock();
    let finishFirst!: () => void;
    let calls = 0;
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async (args) => {
      calls += 1;
      if (args.tempGuid === 'first') {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        return ack;
      }
      if (calls < 4) throw busy();
      return ack;
    });
    const paced = createRcsPacedUploader(upload, {
      ...clock,
      gate: createConcurrencyGate(1),
      random: () => 0.5,
    });

    const first = paced(argsFor('first'));
    const second = paced(argsFor('second'));
    await settle();
    // Ten minutes pass while the second file waits for its turn.
    await clock.sleep(600_000);
    finishFirst();
    await first;

    await expect(second).resolves.toBe(ack);
    expect(upload.mock.calls.filter(([args]) => args.tempGuid === 'second')).toHaveLength(3);
  });

  // Step 1 review: the server reads the whole file before it says busy, so every retry re-sends it.
  it('does not re-send a large file in place when the server is busy', async () => {
    const clock = fakeClock();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      throw busy();
    });
    const paced = createRcsPacedUploader(upload, { ...clock, random: () => 0.5 });

    await expect(
      paced(argsFor('video', { totalBytes: RCS_BUSY_MAX_RESENT_BYTES + 1 })),
    ).rejects.toMatchObject({ status: 503 });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('re-sends a mid-size file only while the extra data stays under the cap', async () => {
    const clock = fakeClock();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => {
      throw busy();
    });
    const paced = createRcsPacedUploader(upload, { ...clock, random: () => 0.5 });
    const size = Math.floor(RCS_BUSY_MAX_RESENT_BYTES / 2.5);

    await expect(paced(argsFor('clip', { totalBytes: size }))).rejects.toMatchObject({
      status: 503,
    });
    // Two re-sends fit under the cap (2 x size), a third would not (3 x size).
    expect(upload).toHaveBeenCalledTimes(3);
  });

  // Step 1 review: one slow upload must not hold every other RCS file indefinitely.
  it('lets separate sends go at once instead of waiting for each other', async () => {
    const clock = fakeClock();
    const started: string[] = [];
    let finishSlow!: () => void;
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async (args) => {
      started.push(args.tempGuid);
      if (args.tempGuid === 'slow') {
        await new Promise<void>((resolve) => {
          finishSlow = resolve;
        });
      }
      return ack;
    });
    const paced = createRcsPacedUploader(upload, { ...clock, random: () => 0.5 });

    const slow = paced(argsFor('slow'));
    // A slow upload in one chat must not hold a photo in another.
    await expect(paced(argsFor('quick'))).resolves.toBe(ack);
    expect(started).toEqual(['slow', 'quick']);

    finishSlow();
    await expect(slow).resolves.toBe(ack);
  });

  it('gives each share its own turns: one share waits for itself, not for another', async () => {
    const started: string[] = [];
    const finishers = new Map<string, () => void>();
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async (args) => {
      started.push(args.tempGuid);
      await new Promise<void>((resolve) => finishers.set(args.tempGuid, resolve));
      return ack;
    });
    const shareA = createRcsShareUploader(upload);
    const shareB = createRcsShareUploader(upload);

    const a1 = shareA(argsFor('a1'));
    const a2 = shareA(argsFor('a2'));
    const b1 = shareB(argsFor('b1'));
    await settle();
    expect(started).toEqual(['a1', 'b1']);

    finishers.get('a1')!();
    await a1;
    await settle();
    expect(started).toEqual(['a1', 'b1', 'a2']);
    finishers.get('a2')!();
    finishers.get('b1')!();
    await Promise.all([a2, b1]);
  });

  it('hands the uploader whole-millisecond limits even with a fractional clock', async () => {
    // React Native's clock is fractional and moves between readings.
    let time = 1_000.25;
    const now = (): number => {
      time += 0.5;
      return time;
    };
    const upload = jest.fn<ReturnType<AttachmentUploader>, [UploadArgs]>(async () => ack);
    const paced = createRcsPacedUploader(upload, { now, random: () => 0.5 });

    await expect(paced(argsFor('temp-1', { timeoutMs: 10_000 }))).resolves.toBe(ack);
    expect(Number.isSafeInteger(upload.mock.calls[0]![0].timeoutMs)).toBe(true);
  });
});
