import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  subscribeRealtimeGenerationInvalidation,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import type { AttachmentRow } from '@db/repositories';
import { useScreenAccountLease } from '@ui/hooks/useScreenAccountLease';
import { readBoundedTextAttachment } from './readBoundedTextAttachment';

export interface ParsedTextAttachmentState<T> {
  attachmentGuid: string;
  localPath: string;
  sourceLifetime: number;
  value: T | null;
}

export interface ParsedTextAttachment<T> {
  /** This screen's account lease; a download started from the card keeps it. */
  accountLease: RealtimeDeliveryLease;
  /** True while the card must render generically: a retired account or a source change. */
  contentUnavailable: boolean;
  /** The last parse result, for whichever source produced it. */
  parsed: ParsedTextAttachmentState<T> | null;
  renderSourceLifetime: number;
  /** Whether a press or result captured for this exact source may still act. */
  sourceGrantIsCurrent: (
    sourceLifetime: number,
    attachmentGuid: string,
    localPath: string | null,
  ) => boolean;
  /** The parsed value for the source shown now, else null. */
  value: T | null;
}

/**
 * Source and account ownership for a small text attachment shown as a card (a vCard contact, an
 * Apple location): once local, its file is read with a size bound and parsed. ContactCard and
 * LocationCard shared this logic as two copies; only LocationCard's copy checked that the card was
 * still mounted (review M235).
 *
 * A grant holds only while the card is mounted, the screen's account lease is current, and the
 * source lifetime, attachment guid and local path are unchanged. `parse` must be a stable
 * module-level function, since a new function on each render would re-read the file.
 */
export function useParsedTextAttachment<T>(
  att: AttachmentRow,
  parse: (text: string) => T | null,
): ParsedTextAttachment<T> {
  const accountLease = useScreenAccountLease();
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [parsed, setParsed] = useState<ParsedTextAttachmentState<T> | null>(null);
  const sourceLifetimeRef = useRef(0);
  // The ref revokes old native callbacks synchronously. Committed state gives a recycled row a
  // fresh callback after the new attachment source becomes current.
  const [renderSourceLifetime, setRenderSourceLifetime] = useState(0);
  const activeAttachment = useRef({ guid: att.guid, localPath: att.localPath });
  const mountedRef = useRef(true);
  const sourceTransitionPending =
    activeAttachment.current.guid !== att.guid ||
    activeAttachment.current.localPath !== att.localPath;

  const revokeSourceLifetime = useCallback((): void => {
    const nextLifetime = sourceLifetimeRef.current + 1;
    sourceLifetimeRef.current = nextLifetime;
    setRenderSourceLifetime(nextLifetime);
    setParsed(null);
  }, []);

  // Render a generic disabled card during a source transition. The layout commit then revokes the
  // previous lifetime before any callback or delayed parse can act for the replacement source.
  useLayoutEffect(() => {
    if (!sourceTransitionPending) return;
    activeAttachment.current = { guid: att.guid, localPath: att.localPath };
    revokeSourceLifetime();
  }, [att.guid, att.localPath, revokeSourceLifetime, sourceTransitionPending]);

  // The captured lease never becomes current again after an account transition. Force the final
  // mounted row to render generically as well as revoking its callbacks and delayed file read.
  // Unmounting revokes them too, so a late open result cannot toast or download for a gone card.
  useLayoutEffect(() => {
    mountedRef.current = true;
    const unsubscribe = subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
      revokeSourceLifetime();
      setAccountRetired(true);
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [accountLease, revokeSourceLifetime]);

  const sourceGrantIsCurrent = useCallback(
    (sourceLifetime: number, attachmentGuid: string, localPath: string | null): boolean => {
      const current = activeAttachment.current;
      return (
        mountedRef.current &&
        accountLease.isCurrent() &&
        sourceLifetimeRef.current === sourceLifetime &&
        current.guid === attachmentGuid &&
        current.localPath === localPath
      );
    },
    [accountLease],
  );

  const contentUnavailable = accountRetired || !accountLease.isCurrent() || sourceTransitionPending;

  useEffect(() => {
    const path = att.localPath;
    const parseSourceLifetime = renderSourceLifetime;
    if (!path || contentUnavailable || !sourceGrantIsCurrent(parseSourceLifetime, att.guid, path)) {
      return;
    }
    const attachmentGuid = att.guid;
    let cancelled = false;
    const canPublish = (): boolean => {
      return !cancelled && sourceGrantIsCurrent(parseSourceLifetime, attachmentGuid, path);
    };
    void (async () => {
      try {
        const text = await readBoundedTextAttachment(path);
        if (canPublish()) {
          setParsed({
            attachmentGuid,
            localPath: path,
            sourceLifetime: parseSourceLifetime,
            value: parse(text),
          });
        }
      } catch {
        if (canPublish()) {
          setParsed({
            attachmentGuid,
            localPath: path,
            sourceLifetime: parseSourceLifetime,
            value: null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    att.guid,
    att.localPath,
    contentUnavailable,
    parse,
    renderSourceLifetime,
    sourceGrantIsCurrent,
  ]);

  const value =
    !contentUnavailable &&
    parsed?.attachmentGuid === att.guid &&
    parsed.localPath === att.localPath &&
    parsed.sourceLifetime === renderSourceLifetime
      ? parsed.value
      : null;

  return {
    accountLease,
    contentUnavailable,
    parsed,
    renderSourceLifetime,
    sourceGrantIsCurrent,
    value,
  };
}
