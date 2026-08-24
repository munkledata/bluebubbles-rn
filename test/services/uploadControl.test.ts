import {
  createConcurrencyGate,
  createUploadRegistry,
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  UploadGateCancelledError,
} from '@/services/send/uploadControl';

/** A promise plus its resolver, so a test can hold an upload open and release it deliberately. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createConcurrencyGate', () => {
  it('runs up to `max` at once and parks the rest', async () => {
    const gate = createConcurrencyGate(2);
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const started: string[] = [];

    const runs = [
      gate.run(async () => {
        started.push('a');
        await a.promise;
      }),
      gate.run(async () => {
        started.push('b');
        await b.promise;
      }),
      gate.run(async () => {
        started.push('c');
        await c.promise;
      }),
    ];
    await flush();

    expect(started).toEqual(['a', 'b']);
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(1);

    a.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']); // the freed slot woke the waiter

    b.resolve();
    c.resolve();
    await Promise.all(runs);
    expect(gate.active).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it('wakes waiters in FIFO order', async () => {
    const gate = createConcurrencyGate(1);
    const first = deferred();
    const started: string[] = [];

    const runs = [
      gate.run(async () => {
        started.push('1');
        await first.promise;
      }),
      gate.run(async () => {
        started.push('2');
      }),
      gate.run(async () => {
        started.push('3');
      }),
    ];
    await flush();
    expect(started).toEqual(['1']);

    first.resolve();
    await Promise.all(runs);
    expect(started).toEqual(['1', '2', '3']);
  });

  it('removes an aborted queued waiter without consuming a slot', async () => {
    const gate = createConcurrencyGate(1);
    const blocker = deferred();
    const first = gate.run(() => blocker.promise);
    await flush();

    const controller = new AbortController();
    const nativeStart = jest.fn(async () => undefined);
    const queued = gate.run(nativeStart, controller.signal);
    await flush();
    expect(gate.active).toBe(1);
    expect(gate.waiting).toBe(1);

    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(UploadGateCancelledError);
    expect(gate.active).toBe(1);
    expect(gate.waiting).toBe(0);
    expect(nativeStart).not.toHaveBeenCalled();

    blocker.resolve();
    await first;
    expect(gate.active).toBe(0);
  });

  it('keeps an aborted active task in its slot until the task itself settles', async () => {
    const gate = createConcurrencyGate(1);
    const activeTask = deferred();
    const controller = new AbortController();
    const first = gate.run(() => activeTask.promise, controller.signal);
    await flush();

    const nextStart = jest.fn(async () => undefined);
    const next = gate.run(nextStart);
    await flush();
    controller.abort();
    await flush();

    expect(gate.active).toBe(1);
    expect(gate.waiting).toBe(1);
    expect(nextStart).not.toHaveBeenCalled();

    activeTask.resolve();
    await Promise.all([first, next]);
    expect(nextStart).toHaveBeenCalledTimes(1);
    expect(gate.active).toBe(0);
  });

  it('releases the slot when the task THROWS', async () => {
    // A leaked slot permanently shrinks the gate; leaking `max` of them wedges every later upload
    // with no error, no log and no way back short of restarting the app.
    const gate = createConcurrencyGate(1);
    await expect(
      gate.run(async () => {
        throw new Error('upload died');
      }),
    ).rejects.toThrow('upload died');

    expect(gate.active).toBe(0);
    await expect(gate.run(async () => 'next one still runs')).resolves.toBe('next one still runs');
  });

  it('returns the task result and clamps a nonsense limit to at least 1', async () => {
    const gate = createConcurrencyGate(0);
    await expect(gate.run(async () => 7)).resolves.toBe(7);
    expect(gate.active).toBe(0);
  });

  it('defaults to the same cap the download side uses', () => {
    expect(DEFAULT_MAX_CONCURRENT_UPLOADS).toBe(2);
  });
});

describe('createUploadRegistry', () => {
  it('cancels the upload registered under a key', () => {
    const registry = createUploadRegistry();
    const cancel = jest.fn();
    registry.add('temp-1', { cancel, settled: Promise.resolve() });

    expect(registry.cancel('temp-1')).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('reports false for a key with nothing in flight', () => {
    // Every "Cancel Sending" routes through here, including for text/reaction/contact messages
    // that register nothing — those must be a silent no-op.
    const registry = createUploadRegistry();
    expect(registry.cancel('temp-text')).toBe(false);
  });

  it('cancels only once — a second cancel finds nothing', () => {
    const registry = createUploadRegistry();
    const cancel = jest.fn();
    registry.add('temp-1', { cancel, settled: Promise.resolve() });

    expect(registry.cancel('temp-1')).toBe(true);
    expect(registry.cancel('temp-1')).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('survives a handle that throws while cancelling', () => {
    const registry = createUploadRegistry();
    registry.add('temp-1', {
      cancel: () => {
        throw new Error('already finished');
      },
      settled: Promise.resolve(),
    });
    expect(() => registry.cancel('temp-1')).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it('release removes the handle it registered', () => {
    const registry = createUploadRegistry();
    const cancel = jest.fn();
    const release = registry.add('temp-1', { cancel, settled: Promise.resolve() });

    release();
    expect(registry.size).toBe(0);
    expect(registry.cancel('temp-1')).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a stale release does NOT unregister the retry's live handle", () => {
    // A retry re-registers the SAME temp guid with a new task. If the previous attempt's release
    // ran afterwards and deleted by key alone, the running upload would silently become
    // uncancellable — the button would report success and nothing would stop.
    const registry = createUploadRegistry();
    const staleCancel = jest.fn();
    const liveCancel = jest.fn();

    const releaseStale = registry.add('temp-1', {
      cancel: staleCancel,
      settled: Promise.resolve(),
    });
    registry.add('temp-1', { cancel: liveCancel, settled: Promise.resolve() }); // retry takes over
    releaseStale(); // the first attempt finally unwinds

    expect(registry.size).toBe(1);
    expect(registry.cancel('temp-1')).toBe(true);
    expect(liveCancel).toHaveBeenCalledTimes(1);
    expect(staleCancel).not.toHaveBeenCalled();
  });

  it('cancels every overlapping attempt registered under the same temp guid', () => {
    const registry = createUploadRegistry();
    const first = jest.fn();
    const retry = jest.fn();
    registry.add('temp-1', { cancel: first, settled: Promise.resolve() });
    registry.add('temp-1', { cancel: retry, settled: Promise.resolve() });

    expect(registry.cancel('temp-1')).toBe(true);

    expect(first).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('tracks concurrent uploads under separate keys', () => {
    const registry = createUploadRegistry();
    const one = jest.fn();
    const two = jest.fn();
    registry.add('temp-1', { cancel: one, settled: Promise.resolve() });
    registry.add('temp-2', { cancel: two, settled: Promise.resolve() });

    expect(registry.size).toBe(2);
    registry.cancel('temp-1');
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it('cancels every upload even when one cancellation throws', () => {
    const registry = createUploadRegistry();
    const first = jest.fn(() => {
      throw new Error('native task already released');
    });
    const second = jest.fn();
    registry.add('temp-1', { cancel: first, settled: Promise.resolve() });
    registry.add('temp-2', { cancel: second, settled: Promise.resolve() });

    expect(registry.cancelAll()).toBe(2);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('prevents a registered queued upload from starting after account teardown', async () => {
    const gate = createConcurrencyGate(1);
    const registry = createUploadRegistry();
    const blocker = deferred();
    const first = gate.run(() => blocker.promise);
    await flush();

    let cancelled = false;
    const nativeStart = jest.fn();
    const release = registry.add('temp-queued', {
      cancel: () => {
        cancelled = true;
      },
      settled: Promise.resolve(),
    });
    const queued = gate.run(async () => {
      // This is the same pre-native-task guard used by attachmentUpload after its gate wait.
      if (cancelled) return null;
      nativeStart();
      return 'started';
    });
    await flush();
    expect(gate.waiting).toBe(1);

    registry.cancelAll();
    blocker.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(queued).resolves.toBeNull();
    expect(nativeStart).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
    // The upload's ordinary finally may still release after cancelAll; identity checking makes it
    // harmless and, importantly, cannot remove a newer account's replacement handle.
    expect(release).not.toThrow();
  });

  it('retains a cancelled native tail until its exact terminal promise settles', async () => {
    const registry = createUploadRegistry();
    const terminal = deferred();
    const cancel = jest.fn();
    registry.add('temp-native', { cancel, settled: terminal.promise });

    expect(registry.cancel('temp-native')).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.pending).toBe(1);
    const idle = registry.awaitIdle();
    let idleSettled = false;
    void idle.then(() => {
      idleSettled = true;
    });
    await Promise.resolve();

    expect(idleSettled).toBe(false);
    terminal.resolve();
    await expect(idle).resolves.toBeUndefined();
    expect(registry.pending).toBe(0);
  });

  it('retries cancellation for an unsettled native tail on a later account sweep', async () => {
    const registry = createUploadRegistry();
    const terminal = deferred();
    const cancel = jest.fn();
    registry.add('temp-native', { cancel, settled: terminal.promise });

    expect(registry.cancelAll()).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(registry.pending).toBe(1);

    expect(registry.cancelAll()).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(registry.pending).toBe(1);

    terminal.resolve();
    await expect(registry.awaitIdle()).resolves.toBeUndefined();
    expect(registry.pending).toBe(0);
    expect(registry.cancelAll()).toBe(0);
  });
});
