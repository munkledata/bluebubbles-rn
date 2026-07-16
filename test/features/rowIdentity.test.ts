/**
 * createRowIdentityCache (src/features/conversations/rowIdentity.ts): the referential-identity
 * preserver behind useMessages/useChats. Every reactive DB flush rebuilds every row object; the
 * cache hands back the PREVIOUS object when a row's content fingerprint is unchanged, so the
 * memoized MessageRow/ConversationTile only re-render on a real change. Locked in:
 *   - an unchanged row (fresh object, same content) keeps its previous identity;
 *   - a changed scalar (sendState) or nested content (reactions length, attachment localPath)
 *     produces a NEW object;
 *   - other rows in the same pass are unaffected by one row's change;
 *   - the ARRAY identity is preserved when nothing at all changed, and replaced otherwise;
 *   - the cache prunes rows that leave the window (no unbounded growth across passes).
 */
import { createRowIdentityCache } from '@features/conversations/rowIdentity';

interface Row {
  guid: string;
  sendState: string;
  reactions: { baseType: string }[];
  attachments: { guid: string; localPath: string | null }[];
}

function mkRow(over: Partial<Row> = {}): Row {
  return { guid: 'g1', sendState: 'sent', reactions: [], attachments: [], ...over };
}

describe('createRowIdentityCache', () => {
  it('returns the previous object for an unchanged row (fresh object, same content)', () => {
    const reconcile = createRowIdentityCache<Row>((r) => r.guid);
    const [first] = reconcile([mkRow()]);
    const [second] = reconcile([mkRow()]); // fresh object, identical content
    expect(second).toBe(first);
  });

  it('returns a new object when a scalar column changed (sendState)', () => {
    const reconcile = createRowIdentityCache<Row>((r) => r.guid);
    const [first] = reconcile([mkRow({ sendState: 'sending' })]);
    const [second] = reconcile([mkRow({ sendState: 'sent' })]);
    expect(second).not.toBe(first);
    expect(second?.sendState).toBe('sent');
  });

  it('returns a new object when nested content changed (reactions length)', () => {
    const reconcile = createRowIdentityCache<Row>((r) => r.guid);
    const [first] = reconcile([mkRow()]);
    const [second] = reconcile([mkRow({ reactions: [{ baseType: 'love' }] })]);
    expect(second).not.toBe(first);
    expect(second?.reactions).toHaveLength(1);
  });

  it('returns a new object when an attachment localPath lands', () => {
    const reconcile = createRowIdentityCache<Row>((r) => r.guid);
    const [first] = reconcile([mkRow({ attachments: [{ guid: 'a1', localPath: null }] })]);
    const [second] = reconcile([mkRow({ attachments: [{ guid: 'a1', localPath: '/f.jpg' }] })]);
    expect(second).not.toBe(first);
    expect(second?.attachments[0]?.localPath).toBe('/f.jpg');
  });

  it('one changed row does not disturb the identity of its unchanged neighbours', () => {
    const reconcile = createRowIdentityCache<Row>((r) => r.guid);
    const firstPass = reconcile([mkRow({ guid: 'g1' }), mkRow({ guid: 'g2' })]);
    const secondPass = reconcile([
      mkRow({ guid: 'g1', sendState: 'error' }),
      mkRow({ guid: 'g2' }),
    ]);
    expect(secondPass[0]).not.toBe(firstPass[0]);
    expect(secondPass[1]).toBe(firstPass[1]);
  });

  it('preserves the array identity when nothing changed, and replaces it otherwise', () => {
    const reconcile = createRowIdentityCache<Row>((r) => r.guid);
    const firstPass = reconcile([mkRow({ guid: 'g1' }), mkRow({ guid: 'g2' })]);
    const samePass = reconcile([mkRow({ guid: 'g1' }), mkRow({ guid: 'g2' })]);
    expect(samePass).toBe(firstPass);

    const changedPass = reconcile([
      mkRow({ guid: 'g1', sendState: 'error' }),
      mkRow({ guid: 'g2' }),
    ]);
    expect(changedPass).not.toBe(firstPass);
  });

  it('prunes rows that left the window (a return after absence is a fresh object)', () => {
    const reconcile = createRowIdentityCache<Row>((r) => r.guid);
    const [first] = reconcile([mkRow({ guid: 'g1' })]);
    reconcile([mkRow({ guid: 'g2' })]); // g1 left the window → dropped from the cache
    const [back] = reconcile([mkRow({ guid: 'g1' })]);
    expect(back).not.toBe(first);
    expect(back).toEqual(first);
  });

  it('honors a custom fingerprint function', () => {
    // Fingerprint on sendState ONLY → a reactions change is (deliberately) invisible.
    const reconcile = createRowIdentityCache<Row>(
      (r) => r.guid,
      (r) => r.sendState,
    );
    const [first] = reconcile([mkRow()]);
    const [second] = reconcile([mkRow({ reactions: [{ baseType: 'like' }] })]);
    expect(second).toBe(first);
    const [third] = reconcile([mkRow({ sendState: 'error' })]);
    expect(third).not.toBe(first);
  });
});
