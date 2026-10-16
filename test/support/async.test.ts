import { waitForCondition, waitForMicrotaskCondition } from './async';

describe('shared async test helpers', () => {
  it('waits for a condition that becomes true and fails loudly when it never does', async () => {
    let ready = false;
    void Promise.resolve().then(() => {
      ready = true;
    });
    await expect(waitForMicrotaskCondition(() => ready, 'ready', 5)).resolves.toBeUndefined();

    await expect(waitForMicrotaskCondition(() => false, 'never', 5)).rejects.toThrow(
      'never did not happen within 5 microtask rounds',
    );
  });

  it('waits across event-loop turns and fails loudly when the condition never holds', async () => {
    let ready = false;
    setImmediate(() => {
      ready = true;
    });
    await expect(waitForCondition(() => ready, 'ready', 3)).resolves.toBeUndefined();

    await expect(waitForCondition(() => false, 'never', 3)).rejects.toThrow(
      'never did not happen within 3 event-loop turns',
    );
  });
});
