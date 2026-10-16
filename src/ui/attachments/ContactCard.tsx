import React, { useRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { openAttachmentFile } from '@/services/openFile';
import { parseVCard } from '@utils';
import { Icon } from '../primitives';
import { readableTextOn, useTheme } from '../theme';
import { showToast } from '../toast/toastStore';
import { useParsedTextAttachment } from './useParsedTextAttachment';

interface ContactCardProps {
  att: AttachmentRow;
  isFromMe: boolean;
  /** The bubble's message-menu action, fired on a hold instead of the attachment's own tap. */
  onLongPress?: () => void;
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
export function ContactCard({ att, isFromMe, onLongPress }: ContactCardProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const {
    accountLease,
    contentUnavailable,
    renderSourceLifetime,
    sourceGrantIsCurrent,
    value: contact,
  } = useParsedTextAttachment(att, parseVCard);
  const opening = useRef<ContactOpenOperation | null>(null);

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
        const res = await openAttachmentFile(localPath, att.mimeType, {
          isCurrent: operationIsCurrent,
        });
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

  // A native open already admitted cannot be recalled. Its result publication stays fenced by the
  // exact token/source/account/mounted checks, so a result that arrives after the card unmounts
  // neither toasts nor downloads, and a callback retained across an unmount is inert.
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
      // A hold opens the message menu (Reply/React/Forward/Delete); without it this press target
      // captured the touch and the bubble's own long-press never fired.
      onLongPress={onLongPress}
      delayLongPress={onLongPress ? 350 : undefined}
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
          <ActivityIndicator color={readableTextOn(theme.color.tint)} size="small" />
        ) : initials ? (
          <Text style={[styles.avatarText, { color: readableTextOn(theme.color.tint) }]}>
            {initials}
          </Text>
        ) : (
          <Icon name="person-outline" size={20} color={readableTextOn(theme.color.tint)} />
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
  avatarText: { fontWeight: '700', fontSize: 15 },
  meta: { flexShrink: 1, flexGrow: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 20, fontWeight: '600' },
});
