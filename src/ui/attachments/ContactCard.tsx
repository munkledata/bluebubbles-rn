import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { openAttachmentFile } from '@/services/openFile';
import { parseVCard, type VCardData } from '@utils';
import { Icon } from '../primitives';
import { useTheme } from '../theme';
import { showToast } from '../toast/toastStore';
import { readBoundedTextAttachment } from './readBoundedTextAttachment';

interface ContactCardProps {
  att: AttachmentRow;
  isFromMe: boolean;
}

interface ParsedContactState {
  attachmentGuid: string;
  localPath: string;
  sourceLifetime: number;
  value: VCardData | null;
}

interface ContactOpenOperation {
  token: symbol;
  attachmentGuid: string;
  localPath: string;
  sourceLifetime: number;
}

/**
 * A contact (vCard) attachment as an iOS-style contact card. The .vcf is text, so it
 * must be downloaded first; once local we read it (expo-file-system `File`) and parse
 * with the pure {@link parseVCard}. Tap downloads (when not local) or opens the card.
 */
export function ContactCard({ att, isFromMe }: ContactCardProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [parsed, setParsed] = useState<ParsedContactState | null>(null);
  const sourceLifetimeRef = useRef(0);
  // The ref revokes old native callbacks synchronously. Committed state gives a recycled row a
  // fresh callback after its replacement source becomes current.
  const [renderSourceLifetime, setRenderSourceLifetime] = useState(0);
  const activeAttachment = useRef({ guid: att.guid, localPath: att.localPath });
  const opening = useRef<ContactOpenOperation | null>(null);
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
  // prior lifetime before a callback or delayed result can act for the replacement source.
  useLayoutEffect(() => {
    if (!sourceTransitionPending) return;
    activeAttachment.current = { guid: att.guid, localPath: att.localPath };
    revokeSourceLifetime();
  }, [att.guid, att.localPath, revokeSourceLifetime, sourceTransitionPending]);

  // The original lease never becomes current again after an account transition. Revoke the
  // lifetime synchronously and force any briefly retained row to render generically.
  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        revokeSourceLifetime();
        setAccountRetired(true);
      }),
    [accountLease, revokeSourceLifetime],
  );

  const sourceGrantIsCurrent = useCallback(
    (sourceLifetime: number, attachmentGuid: string, localPath: string | null): boolean => {
      const current = activeAttachment.current;
      return (
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
            value: parseVCard(text),
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
  }, [att.guid, att.localPath, contentUnavailable, renderSourceLifetime, sourceGrantIsCurrent]);

  const contact =
    !contentUnavailable &&
    parsed?.attachmentGuid === att.guid &&
    parsed.localPath === att.localPath &&
    parsed.sourceLifetime === renderSourceLifetime
      ? parsed.value
      : null;

  const onPress = (): void => {
    const operationSourceLifetime = renderSourceLifetime;
    const attachmentGuid = att.guid;
    const localPath = att.localPath;
    const operationIsCurrent = (): boolean =>
      sourceGrantIsCurrent(operationSourceLifetime, attachmentGuid, localPath);
    if (!operationIsCurrent()) return;

    if (!localPath) {
      if (!operationIsCurrent()) return;
      // Once admitted, the download may finish after account retirement. Its original lease keeps
      // every later commit scoped to that same account.
      void download(att, 'manual', accountLease);
      return;
    }
    if (!operationIsCurrent()) return;
    const activeOpen = opening.current;
    if (
      activeOpen?.attachmentGuid === attachmentGuid &&
      activeOpen.localPath === localPath &&
      activeOpen.sourceLifetime === operationSourceLifetime
    ) {
      return;
    }
    const openToken = Symbol('contact-open');
    opening.current = {
      token: openToken,
      attachmentGuid,
      localPath,
      sourceLifetime: operationSourceLifetime,
    };
    const operationOwnsOpenToken = (): boolean => opening.current?.token === openToken;
    void (async () => {
      try {
        const res = await openAttachmentFile(localPath, att.mimeType);
        if (!operationOwnsOpenToken() || !operationIsCurrent()) return;
        // A 'missing' result here also explains an empty inline card (the effect above reads the
        // same file), so re-downloading is the right response to both.
        if (res.status === 'missing') void download(att, 'manual', accountLease);
        else if (res.status === 'no_handler')
          showToast('No app on this device can open contact cards');
        else if (res.status === 'error') showToast('Couldn’t open this contact card');
      } catch {
        if (operationOwnsOpenToken() && operationIsCurrent()) {
          showToast('Couldn’t open this contact card');
        }
      } finally {
        if (opening.current?.token === openToken) opening.current = null;
      }
    })();
  };

  // A native open already admitted cannot be recalled. Its result publication remains fenced by
  // the exact token/source/account checks above. A callback manually retained across an arbitrary
  // same-account unmount is outside this source lifetime; React normally removes Pressability.
  const title = contentUnavailable
    ? 'Contact'
    : (contact?.displayName ?? att.transferName ?? 'Contact');
  const subtitle = contentUnavailable
    ? 'Contact unavailable.'
    : contact
      ? (contact.phones[0] ?? contact.emails[0] ?? 'Contact card')
      : status === 'downloading'
        ? 'Downloading…'
        : status === 'error'
          ? 'Tap to retry'
          : 'Tap to view contact';
  const initials = contentUnavailable
    ? ''
    : title
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join('');

  return (
    <Pressable
      onPress={contentUnavailable ? undefined : onPress}
      disabled={contentUnavailable}
      accessibilityRole="button"
      accessibilityLabel={contentUnavailable ? 'Contact unavailable' : `Contact: ${title}`}
      accessibilityState={{ disabled: contentUnavailable }}
      style={[
        styles.chip,
        {
          backgroundColor: theme.color.secondaryBackground,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View style={[styles.avatar, { backgroundColor: theme.color.tint }]}>
        {!contentUnavailable && status === 'downloading' ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : initials ? (
          <Text style={styles.avatarText}>{initials}</Text>
        ) : (
          <Icon name="person-outline" size={20} color="#fff" />
        )}
      </View>
      <View style={styles.meta}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.color.label }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {subtitle}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: theme.color.tertiaryLabel }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '78%',
    marginVertical: 2,
    marginHorizontal: 10,
    padding: 10,
    borderRadius: 14,
    gap: 10,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  meta: { flexShrink: 1, flexGrow: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 20, fontWeight: '600' },
});
