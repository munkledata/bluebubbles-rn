import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import type { AttachmentRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { parseVLocation, resolveDisplayPoint, safeOpenUrl, type VLocationData } from '@utils';
import { Icon } from '../primitives';
import { readableTextOn, useTheme } from '../theme';
import { readBoundedTextAttachment } from './readBoundedTextAttachment';

interface LocationCardProps {
  att: AttachmentRow;
  isFromMe: boolean;
}

interface ParsedLocationState {
  attachmentGuid: string;
  localPath: string;
  sourceLifetime: number;
  value: VLocationData | null;
}

/**
 * An Apple location (.loc.vcf) attachment as a tappable map-link card. Downloaded then
 * parsed with the pure {@link parseVLocation}. Tap opens a `geo:` URL (Android-native,
 * consistent with the Find My "Open in Maps" fallback) — no Maps API key needed.
 */
export function LocationCard({ att, isFromMe }: LocationCardProps): React.JSX.Element {
  const theme = useTheme();
  const status = useDownloadStore((s) => s.status[att.guid]);
  const [parsed, setParsed] = useState<ParsedLocationState | null>(null);
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const sourceLifetimeRef = useRef(0);
  // The ref revokes old native callbacks synchronously. Committed state gives a recycled row a
  // fresh callback after the new attachment source becomes current.
  const [renderSourceLifetime, setRenderSourceLifetime] = useState(0);
  const activeAttachment = useRef({ guid: att.guid, localPath: att.localPath });
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
            value: parseVLocation(text),
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

  const loc =
    !contentUnavailable &&
    parsed?.attachmentGuid === att.guid &&
    parsed.localPath === att.localPath &&
    parsed.sourceLifetime === renderSourceLifetime
      ? parsed.value
      : null;

  // Keep the shared finite-pair validator between parsed data and every rendered/native value.
  const point = resolveDisplayPoint(loc?.latitude, loc?.longitude);

  const onPress = (): void => {
    const operationSourceLifetime = renderSourceLifetime;
    const attachmentGuid = att.guid;
    const localPath = att.localPath;
    const operationIsCurrent = (): boolean =>
      sourceGrantIsCurrent(operationSourceLifetime, attachmentGuid, localPath);
    if (!operationIsCurrent()) return;

    if (!localPath) {
      if (!operationIsCurrent()) return;
      // Once admitted, a download may finish after account retirement. Its captured lease keeps
      // any later commit scoped to the original account.
      void download(att, 'manual', accountLease);
      return;
    }

    const parsedForPath =
      parsed?.attachmentGuid === attachmentGuid && parsed.localPath === localPath
        ? parsed.sourceLifetime === operationSourceLifetime
          ? parsed.value
          : null
        : null;
    const actionPoint = resolveDisplayPoint(parsedForPath?.latitude, parsedForPath?.longitude);
    if (!actionPoint.visible || !operationIsCurrent()) {
      return;
    }
    const { latitude, longitude } = actionPoint;
    const geoUrl = `geo:${latitude},${longitude}?q=${latitude},${longitude}`;
    // Once handed to Android this intent cannot be recalled by a later account transition.
    void safeOpenUrl(geoUrl);
  };

  // A callback manually retained across an arbitrary same-account unmount is outside this
  // source/account lifetime. React removes the native Pressability config during normal unmount.
  const subtitle = contentUnavailable
    ? 'Location unavailable.'
    : point.visible
      ? `${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`
      : status === 'downloading'
        ? 'Downloading…'
        : status === 'error'
          ? 'Tap to retry'
          : 'Tap to open';

  return (
    <Pressable
      onPress={contentUnavailable ? undefined : onPress}
      disabled={contentUnavailable}
      accessibilityRole="button"
      accessibilityLabel={contentUnavailable ? 'Location unavailable' : 'Location'}
      accessibilityState={{ disabled: contentUnavailable }}
      style={[
        styles.chip,
        {
          backgroundColor: theme.color.secondaryBackground,
          alignSelf: isFromMe ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View style={[styles.icon, { backgroundColor: theme.color.tint }]}>
        {!contentUnavailable && status === 'downloading' ? (
          <ActivityIndicator color={readableTextOn(theme.color.tint)} size="small" />
        ) : (
          <Icon name="location-outline" size={22} color={readableTextOn(theme.color.tint)} />
        )}
      </View>
      <View style={styles.meta}>
        <Text numberOfLines={1} style={[styles.name, { color: theme.color.label }]}>
          {contentUnavailable ? 'Location' : (att.transferName ?? 'Location')}
        </Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>{subtitle}</Text>
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
  icon: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  meta: { flexShrink: 1, flexGrow: 1 },
  name: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 20, fontWeight: '600' },
});
