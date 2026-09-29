import { useRouter } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  collectDownloadIntegrityDiagnostics,
  type DownloadIntegrityReport,
} from '@/services/download/downloadIntegrityDiagnostics';
import {
  captureRealtimeDeliveryLease,
  subscribeRealtimeGenerationInvalidation,
} from '@/services/realtime/deliveryCoordinator';
import { InfoRow, NoteRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';

const yesNo = (value: boolean | null): string =>
  value === null ? 'Unavailable' : value ? 'Yes' : 'No';

const statusLabel = (value: 'verified' | 'rejected'): string =>
  value === 'verified' ? 'Verified' : 'Rejected';

const numberLabel = (value: number | null): string =>
  value === null ? 'Unavailable' : value.toLocaleString();

const bytesLabel = (value: number | null): string => {
  if (value === null) return 'Unavailable';
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KiB`;
  return `${value.toLocaleString()} B`;
};

/** Read-only, privacy-safe exact-candidate evidence for DL-01. */
export default function DownloadIntegrityScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const [accountLease] = useState(captureRealtimeDeliveryLease);
  const mountedRef = useRef(true);
  const [accountRetired, setAccountRetired] = useState(() => !accountLease.isCurrent());
  const [report, setReport] = useState<DownloadIntegrityReport | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef(0);

  useLayoutEffect(
    () =>
      subscribeRealtimeGenerationInvalidation(accountLease.generation, () => {
        setAccountRetired(true);
      }),
    [accountLease],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback((): void => {
    if (!accountLease.isCurrent()) return;
    requestRef.current += 1;
    const request = requestRef.current;
    setRefreshing(true);
    setFailed(false);
    setReport(null);
    void collectDownloadIntegrityDiagnostics(accountLease)
      .then((next) => {
        if (!mountedRef.current || request !== requestRef.current) return;
        if (!accountLease.isCurrent() || next === null) {
          setAccountRetired(true);
          return;
        }
        setReport(next);
      })
      .catch(() => {
        if (mountedRef.current && request === requestRef.current && accountLease.isCurrent()) {
          setFailed(true);
        }
      })
      .finally(() => {
        if (mountedRef.current && request === requestRef.current && accountLease.isCurrent()) {
          setRefreshing(false);
        }
      });
  }, [accountLease]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initial diagnostics intentionally enter the same refresh lifecycle as a manual refresh.
    load();
  }, [load]);

  const accountCurrent = !accountRetired && accountLease.isCurrent();

  return (
    <Screen>
      <ScreenHeader
        title="Download Integrity"
        onBack={() => router.back()}
        right={
          accountCurrent ? (
            <Pressable
              onPress={load}
              disabled={refreshing}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Refresh download integrity"
            >
              <Text style={[styles.action, { color: theme.color.tint }]}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Text>
            </Pressable>
          ) : null
        }
      />

      {!accountCurrent ? (
        <View style={styles.message}>
          <Text style={[styles.messageText, { color: theme.color.secondaryLabel }]}>
            Server account changed. Go back and reopen Download Integrity.
          </Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={load} tintColor={theme.color.tint} />
          }
        >
          {failed ? (
            <SettingsSection label="REPORT">
              <NoteRow text="Download integrity is unavailable. Wait for active downloads to settle, then refresh." />
            </SettingsSection>
          ) : report === null ? (
            <SettingsSection label="REPORT">
              <NoteRow text="Reading encrypted database and app-private file state…" />
            </SettingsSection>
          ) : (
            <>
              <SettingsSection label="EXACT CANDIDATE">
                <InfoRow label="App version" value={report.candidate.appVersion} />
                <InfoRow label="App build" value={report.candidate.appBuild} />
                <InfoRow label="Android API" value={report.candidate.androidApi} />
                <InfoRow
                  label="Schema migrations"
                  value={numberLabel(report.candidate.migrationCount)}
                />
                <InfoRow label="Schema head" value={report.candidate.migrationHead} />
                <InfoRow
                  label="DB / ownership bookends"
                  value={yesNo(report.databaseAndOwnershipMatched)}
                />
              </SettingsSection>

              <SettingsSection label="DOWNLOAD ACTIVITY" style={styles.gap}>
                <InfoRow
                  label="Active transfers"
                  value={numberLabel(report.downloads.activeTransfers)}
                />
                <InfoRow
                  label="Owned destinations"
                  value={numberLabel(report.downloads.activeDestinations)}
                />
                <InfoRow
                  label="Temporary scan"
                  value={statusLabel(report.downloads.partialInspection)}
                />
                <InfoRow
                  label="Temporary files"
                  value={numberLabel(report.downloads.partialFiles)}
                />
                <InfoRow
                  label="Temporary bytes"
                  value={bytesLabel(report.downloads.partialBytes)}
                />
              </SettingsSection>

              <SettingsSection label="GALLERY / ALBUM RECEIPTS" style={styles.gap}>
                <InfoRow label="Pending" value={numberLabel(report.receipts.pending)} />
                <InfoRow label="Completed" value={numberLabel(report.receipts.completed)} />
                <InfoRow label="Terminal" value={numberLabel(report.receipts.terminal)} />
                <InfoRow label="Gallery" value={numberLabel(report.receipts.gallery)} />
                <InfoRow label="Gator Album" value={numberLabel(report.receipts.album)} />
                <InfoRow
                  label="Attempts 0 / 1"
                  value={`${report.receipts.attempts0} / ${report.receipts.attempts1}`}
                />
                <InfoRow
                  label="Attempts 2 / 3"
                  value={`${report.receipts.attempts2} / ${report.receipts.attempts3}`}
                />
                <InfoRow label="Active leases" value={numberLabel(report.receipts.leased)} />
                <InfoRow
                  label="Latest receipt present"
                  value={yesNo(report.receipts.latestPresent)}
                />
                <InfoRow label="Latest pending" value={yesNo(report.receipts.latestPending)} />
                <InfoRow label="Latest completed" value={yesNo(report.receipts.latestCompleted)} />
                <InfoRow label="Latest terminal" value={yesNo(report.receipts.latestTerminal)} />
                <InfoRow label="Latest Gallery" value={yesNo(report.receipts.latestGallery)} />
                <InfoRow label="Latest Gator Album" value={yesNo(report.receipts.latestAlbum)} />
                <InfoRow label="Latest leased" value={yesNo(report.receipts.latestLeased)} />
                <InfoRow
                  label="Latest attempts"
                  value={numberLabel(report.receipts.latestAttempts)}
                />
                <InfoRow
                  label="Latest has local path"
                  value={yesNo(report.receipts.latestHasLocalPath)}
                />
              </SettingsSection>

              <SettingsSection label="ATTACHMENT CACHE" style={styles.gap}>
                <InfoRow label="Attachment rows" value={numberLabel(report.attachments.rows)} />
                <InfoRow
                  label="Rows with local path"
                  value={numberLabel(report.attachments.localPathRows)}
                />
                <InfoRow
                  label="Distinct local paths"
                  value={numberLabel(report.attachments.distinctLocalPaths)}
                />
                <InfoRow label="Ledger files" value={numberLabel(report.cache.ledgerFiles)} />
                <InfoRow label="Ledger bytes" value={bytesLabel(report.cache.ledgerBytes)} />
                <InfoRow
                  label="Active files / bytes"
                  value={`${report.cache.activeFiles} / ${bytesLabel(report.cache.activeBytes)}`}
                />
                <InfoRow
                  label="Reserved files / bytes"
                  value={`${report.cache.reservedFiles} / ${bytesLabel(report.cache.reservedBytes)}`}
                />
                <InfoRow
                  label="Retiring files / bytes"
                  value={`${report.cache.retiringFiles} / ${bytesLabel(report.cache.retiringBytes)}`}
                />
                <InfoRow label="Within 2 GiB" value={yesNo(report.cache.withinByteLimit)} />
                <InfoRow label="Within 4,096 files" value={yesNo(report.cache.withinFileLimit)} />
                <InfoRow label="Native scan" value={statusLabel(report.cache.nativeInspection)} />
                <InfoRow label="Native files" value={numberLabel(report.cache.nativeFiles)} />
                <InfoRow label="Native bytes" value={bytesLabel(report.cache.nativeBytes)} />
                <InfoRow label="Missing active" value={numberLabel(report.cache.activeMissing)} />
                <InfoRow
                  label="Byte mismatches"
                  value={numberLabel(report.cache.activeByteMismatches)}
                />
                <InfoRow
                  label="Reserved present / missing"
                  value={`${numberLabel(report.cache.reservedPresent)} / ${numberLabel(report.cache.reservedMissing)}`}
                />
                <InfoRow
                  label="Retiring present / missing"
                  value={`${numberLabel(report.cache.retiringPresent)} / ${numberLabel(report.cache.retiringMissing)}`}
                />
                <InfoRow
                  label="Untracked native"
                  value={numberLabel(report.cache.untrackedNative)}
                />
                <InfoRow label="Settled DB/file exact" value={yesNo(report.cache.settledExact)} />
                <InfoRow
                  label="Current generation"
                  value={numberLabel(report.cache.currentGenerationFiles)}
                />
                <InfoRow
                  label="Foreign generation"
                  value={numberLabel(report.cache.foreignGenerationFiles)}
                />
                <InfoRow
                  label="Unscoped generation"
                  value={numberLabel(report.cache.unscopedGenerationFiles)}
                />
                <InfoRow
                  label="Legacy layout"
                  value={numberLabel(report.cache.legacyLayoutFiles)}
                />
                <InfoRow
                  label="Free-space scan"
                  value={statusLabel(report.cache.freeSpaceInspection)}
                />
                <InfoRow
                  label="Available storage"
                  value={bytesLabel(report.cache.availableBytes)}
                />
                <InfoRow label="512 MiB floor met" value={yesNo(report.cache.freeSpaceFloorMet)} />
              </SettingsSection>

              <SettingsSection label="LIVE OWNERSHIP" style={styles.gap}>
                <InfoRow
                  label="Reservations"
                  value={numberLabel(report.coordinator.reservations)}
                />
                <InfoRow
                  label="Reserved maximum"
                  value={bytesLabel(report.coordinator.reservedBytes)}
                />
                <InfoRow
                  label="Retirement owners"
                  value={numberLabel(report.coordinator.retirementOwners)}
                />
                <InfoRow
                  label="Pending retirements"
                  value={numberLabel(report.coordinator.pendingRetirements)}
                />
                <InfoRow
                  label="Protected paths"
                  value={numberLabel(report.coordinator.protectedPaths)}
                />
                <InfoRow
                  label="Protection owners"
                  value={numberLabel(report.coordinator.protectionOwners)}
                />
              </SettingsSection>

              <SettingsSection label="SYNCED WALLPAPERS" style={styles.gap}>
                <InfoRow label="DB channels" value={numberLabel(report.wallpapers.channelRows)} />
                <InfoRow
                  label="DB local references"
                  value={numberLabel(report.wallpapers.localPathRows)}
                />
                <InfoRow
                  label="Distinct references"
                  value={numberLabel(report.wallpapers.distinctLocalPaths)}
                />
                <InfoRow
                  label="Channel without path"
                  value={numberLabel(report.wallpapers.channelWithoutLocalPath)}
                />
                <InfoRow
                  label="Path without channel"
                  value={numberLabel(report.wallpapers.localPathWithoutChannel)}
                />
                <InfoRow
                  label="Native scan"
                  value={statusLabel(report.wallpapers.nativeInspection)}
                />
                <InfoRow label="Native files" value={numberLabel(report.wallpapers.nativeFiles)} />
                <InfoRow label="Native bytes" value={bytesLabel(report.wallpapers.nativeBytes)} />
                <InfoRow
                  label="Within 90 MiB / 255"
                  value={yesNo(report.wallpapers.withinAdmissionLimit)}
                />
                <InfoRow
                  label="Within 100 MiB / 256"
                  value={yesNo(report.wallpapers.withinFinalLimit)}
                />
                <InfoRow
                  label="Reference scan"
                  value={statusLabel(report.wallpapers.referenceInspection)}
                />
                <InfoRow
                  label="Valid references"
                  value={numberLabel(report.wallpapers.validReferences)}
                />
                <InfoRow
                  label="Invalid or missing"
                  value={numberLabel(report.wallpapers.invalidOrMissingReferences)}
                />
              </SettingsSection>

              <NoteRow text="This report shows fixed booleans and aggregate counts only. It never displays message data, filenames, paths, URLs, credentials, or encryption material." />
            </>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  action: { fontSize: 16, fontWeight: '600' },
  content: { padding: 16, paddingBottom: 40 },
  gap: { marginTop: 24 },
  message: { padding: 24 },
  messageText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
