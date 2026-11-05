import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useRef, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { isCanonicalFaceTimeCallAddress } from '@core/api/endpoints/facetime';
import { createAppleFaceTimeLink, startAppleFaceTimeCall } from '@/services';
import { useSessionStore } from '@state/sessionStore';
import { Button, Screen, ScreenHeader, SettingsSection, TextField, useTheme } from '@ui';

/**
 * What the person typed, in the one exact shape the Mac accepts: "+15551234567" or a lowercase
 * email. Spaces, brackets, dots and dashes are dropped, and a 10-digit number is read as US/Canada
 * (+1), as the rest of the app formats it. The screen shows the result before calling. Null when the
 * text still isn't a callable address.
 */
function canonicalCallAddress(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed.includes('@')) {
    const email = trimmed.toLowerCase();
    return isCanonicalFaceTimeCallAddress(email) ? email : null;
  }
  if (!/^\+?[\d\s().-]+$/u.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/gu, '');
  const candidate = trimmed.startsWith('+')
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith('1')
        ? `+${digits}`
        : null;
  return candidate && isCanonicalFaceTimeCallAddress(candidate) ? candidate : null;
}

type LinkResultNotice = 'rejected' | 'outcome-unknown' | 'copied' | 'copy-failed' | 'share-failed';
type CallResultNotice = 'started' | 'rejected' | 'outcome-unknown';
type BusyAction = 'link' | 'audio-call' | 'video-call';

function linkNoticeText(notice: LinkResultNotice | null): string | null {
  if (notice === 'rejected') return 'No FaceTime link was created. You can try again.';
  if (notice === 'outcome-unknown') {
    return 'The result could not be confirmed. Check FaceTime before creating another link.';
  }
  if (notice === 'copied') return 'Link copied.';
  if (notice === 'copy-failed') return 'Couldn’t copy the link. You can still share it.';
  if (notice === 'share-failed') return 'Couldn’t open the share sheet. You can still copy it.';
  return null;
}

function callNoticeText(notice: CallResultNotice | null): string | null {
  if (notice === 'started') return 'FaceTime call started.';
  if (notice === 'rejected')
    return 'FaceTime did not start the call. Check the address and try again.';
  if (notice === 'outcome-unknown') {
    return 'The call result could not be confirmed. Check FaceTime before trying again.';
  }
  return null;
}

/** FaceTime exposes only separately capable one-shot link creation and call starting. */
export default function FaceTimeScreen(): React.JSX.Element {
  const router = useRouter();
  const status = useSessionStore((s) => s.status);
  const epoch = useSessionStore((s) => s.epoch);
  const transportRevision = useSessionStore((s) => s.transportRevision);
  const capabilityRevision = useSessionStore((s) => s.sendCapabilityRevision);
  const canCreateLink = useSessionStore(
    (s) =>
      s.status === 'connected' &&
      !!s.origin &&
      !!s.password &&
      s.serverInfo?.supports_facetime_link_creation === true,
  );
  const canStartCall = useSessionStore(
    (s) =>
      s.status === 'connected' &&
      !!s.origin &&
      !!s.password &&
      s.serverInfo?.supports_facetime_call_start === true,
  );
  const ownerKey = `${status}:${epoch}:${transportRevision}:${capabilityRevision}:${Number(canCreateLink)}:${Number(canStartCall)}`;

  return (
    <Screen grouped>
      <ScreenHeader title="FaceTime" onBack={() => router.back()} />
      {/* Remounting this owner-local body discards its address and bearer URL immediately on
          account, credential/origin, or capability change without writing either to app data. */}
      <FaceTimeOwnerBody
        key={ownerKey}
        status={status}
        canCreateLink={canCreateLink}
        canStartCall={canStartCall}
      />
    </Screen>
  );
}

function FaceTimeOwnerBody({
  status,
  canCreateLink,
  canStartCall,
}: {
  readonly status: ReturnType<typeof useSessionStore.getState>['status'];
  readonly canCreateLink: boolean;
  readonly canStartCall: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const busyRef = useRef(false);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [address, setAddress] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<LinkResultNotice | null>(null);
  const [callNotice, setCallNotice] = useState<CallResultNotice | null>(null);
  const busy = busyAction != null;
  const callAddress = canonicalCallAddress(address);
  const validCallAddress = callAddress != null;

  const beginAction = (action: BusyAction): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusyAction(action);
    return true;
  };

  const endAction = (): void => {
    busyRef.current = false;
    setBusyAction(null);
  };

  const onCreate = (): void => {
    if (!canCreateLink || !beginAction('link')) return;
    setLink(null);
    setLinkNotice(null);
    void createAppleFaceTimeLink()
      .then((result) => {
        if (result?.status === 'accepted') {
          setLink(result.link);
          return;
        }
        if (result?.status === 'rejected') setLinkNotice('rejected');
        else if (result?.status === 'outcome-unknown') setLinkNotice('outcome-unknown');
      })
      .catch(() => {
        // Do not copy the original Error into state/logs: it may have crossed the bearer response.
        setLinkNotice('outcome-unknown');
      })
      .finally(endAction);
  };

  const onStartCall = (video: boolean): void => {
    if (!canStartCall || callAddress == null) return;
    const action: BusyAction = video ? 'video-call' : 'audio-call';
    if (!beginAction(action)) return;
    const submittedAddress = callAddress;
    setCallNotice(null);
    void startAppleFaceTimeCall({ address: submittedAddress, video })
      .then((result) => {
        if (result?.status === 'accepted') setCallNotice('started');
        else if (result?.status === 'rejected') setCallNotice('rejected');
        else if (result?.status === 'outcome-unknown') setCallNotice('outcome-unknown');
      })
      .catch(() => setCallNotice('outcome-unknown'))
      .finally(endAction);
  };

  const onCopy = (): void => {
    if (!link) return;
    const value = link;
    void Clipboard.setStringAsync(value).then(
      () => setLinkNotice('copied'),
      () => setLinkNotice('copy-failed'),
    );
  };

  const onShare = (): void => {
    if (!link) return;
    const value = link;
    void Share.share({ message: value }).catch(() => setLinkNotice('share-failed'));
  };

  const linkResultNotice = linkNoticeText(linkNotice);
  const callResultNotice = callNoticeText(callNotice);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
    >
      <SettingsSection label="AVAILABILITY">
        <View style={styles.row}>
          <Text style={[styles.body, { color: theme.color.secondaryLabel }]}>
            {canStartCall
              ? 'Answering, leaving calls, and call events remain unavailable in Gator.'
              : 'FaceTime calling, answering, leaving calls, and call events are unavailable in Gator.'}
          </Text>
        </View>
      </SettingsSection>

      {canStartCall ? (
        <SettingsSection label="FACETIME CALL" style={styles.sectionGap}>
          <View style={styles.actionRow}>
            <Text style={[styles.body, { color: theme.color.secondaryLabel }]}>
              Enter a phone number or email address. Gator asks your Mac to start the call, and the
              call itself happens on the Mac.
            </Text>
            <TextField
              label="Phone or email"
              accessibilityLabel="FaceTime call address"
              placeholder="+15551234567 or name@example.com"
              value={address}
              onChangeText={setAddress}
              editable={!busy}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              returnKeyType="done"
            />
            {callAddress != null && callAddress !== address.trim() ? (
              <Text style={[styles.body, { color: theme.color.secondaryLabel }]}>
                {`Calls ${callAddress}`}
              </Text>
            ) : null}
            <View style={styles.callActions}>
              <Button
                title="Audio Call"
                onPress={() => onStartCall(false)}
                loading={busyAction === 'audio-call'}
                disabled={busy || !validCallAddress}
                style={styles.action}
              />
              <Button
                title="Video Call"
                onPress={() => onStartCall(true)}
                loading={busyAction === 'video-call'}
                disabled={busy || !validCallAddress}
                style={styles.action}
              />
            </View>
          </View>
          {callResultNotice ? (
            <View style={styles.row}>
              <Text selectable style={[styles.notice, { color: theme.color.secondaryLabel }]}>
                {callResultNotice}
              </Text>
            </View>
          ) : null}
        </SettingsSection>
      ) : status === 'connected' ? (
        <Text style={[styles.unavailable, { color: theme.color.secondaryLabel }]}>
          This server does not support starting FaceTime calls.
        </Text>
      ) : null}

      {canCreateLink ? (
        <SettingsSection label="FACETIME LINK" style={styles.sectionGap}>
          <View style={styles.actionRow}>
            <Text style={[styles.body, { color: theme.color.secondaryLabel }]}>
              Create a plain Apple FaceTime link to copy or share. Anyone with the link may be able
              to join, so share it carefully.
            </Text>
            <Button
              title="Create FaceTime Link"
              onPress={onCreate}
              loading={busyAction === 'link'}
              disabled={busy}
            />
          </View>
          {link ? (
            <View style={styles.linkRow}>
              <Text
                selectable
                accessibilityLabel="Created FaceTime link"
                style={[styles.link, { color: theme.color.label }]}
              >
                {link}
              </Text>
              <View style={styles.linkActions}>
                <Button
                  title="Copy"
                  variant="tinted"
                  onPress={onCopy}
                  disabled={busy}
                  style={styles.action}
                />
                <Button
                  title="Share"
                  variant="tinted"
                  onPress={onShare}
                  disabled={busy}
                  style={styles.action}
                />
              </View>
            </View>
          ) : null}
          {linkResultNotice ? (
            <View style={styles.row}>
              <Text selectable style={[styles.notice, { color: theme.color.secondaryLabel }]}>
                {linkResultNotice}
              </Text>
            </View>
          ) : null}
        </SettingsSection>
      ) : status === 'connected' ? (
        <Text style={[styles.unavailable, { color: theme.color.secondaryLabel }]}>
          This server does not support FaceTime link creation.
        </Text>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingVertical: 24, paddingBottom: 40 },
  sectionGap: { marginTop: 24 },
  row: { paddingHorizontal: 16, paddingVertical: 14 },
  actionRow: { padding: 16, gap: 14 },
  body: { fontSize: 15, lineHeight: 21 },
  linkRow: { padding: 16, gap: 14 },
  link: { fontSize: 14, lineHeight: 20 },
  linkActions: { flexDirection: 'row', gap: 12 },
  callActions: { flexDirection: 'row', gap: 12 },
  action: { flex: 1 },
  notice: { fontSize: 14, lineHeight: 20 },
  unavailable: { fontSize: 14, lineHeight: 20, marginHorizontal: 12, marginTop: 14 },
});
