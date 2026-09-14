import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import {
  LEGAL_INVENTORY_SUMMARY,
  PROJECT_NOTICE_TEXT,
  THIRD_PARTY_NOTICES_TEXT,
} from '@/generated/legalNotices';
import { NavRow, Screen, ScreenHeader, SettingsSection, useTheme } from '@ui';
import { safeOpenUrl } from '@utils';

const GOOGLE_MAPS_ADDITIONAL_TERMS_URL = 'https://maps.google.com/help/terms_maps/';
const GOOGLE_PRIVACY_POLICY_URL = 'https://policies.google.com/privacy';

/** Local copy of the project terms and reviewed notices; no network access is needed. */
export default function LegalNoticesScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const textStyle = [styles.text, { color: theme.color.secondaryLabel }];

  return (
    <Screen>
      <ScreenHeader title="Legal & Notices" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsSection label="PROJECT TERMS">
          <Text selectable style={textStyle}>
            {PROJECT_NOTICE_TEXT}
          </Text>
        </SettingsSection>

        <SettingsSection label="GOOGLE MAPS TERMS" style={styles.gap}>
          <Text selectable style={textStyle}>
            Gator includes Google Maps features and content. Use of those features and content is
            subject to the current Google Maps End User Additional Terms of Service and Google
            Privacy Policy.
          </Text>
          <NavRow
            label="Google Maps End User Additional Terms…"
            accessibilityLabel="Open Google Maps End User Additional Terms"
            onPress={() => {
              void safeOpenUrl(GOOGLE_MAPS_ADDITIONAL_TERMS_URL);
            }}
          />
          <NavRow
            label="Google Privacy Policy…"
            accessibilityLabel="Open Google Privacy Policy"
            onPress={() => {
              void safeOpenUrl(GOOGLE_PRIVACY_POLICY_URL);
            }}
          />
        </SettingsSection>

        <SettingsSection label="CONFIRMED THIRD-PARTY NOTICE" style={styles.gap}>
          <Text selectable style={textStyle}>
            {THIRD_PARTY_NOTICES_TEXT}
          </Text>
        </SettingsSection>

        <SettingsSection label="INVENTORY STATUS" style={styles.gap}>
          <Text selectable style={textStyle}>
            The current source audit records {LEGAL_INVENTORY_SUMMARY.productionPackageRecords}{' '}
            conservative production-lock package records and {LEGAL_INVENTORY_SUMMARY.assetFiles}{' '}
            tracked app and store artwork files. It also records{' '}
            {LEGAL_INVENTORY_SUMMARY.localComponents} local native modules or build plugins.
          </Text>
          <Text selectable style={textStyle}>
            This is technical inventory evidence, not legal approval or an exact Android App Bundle
            notice review. Asset provenance remains pending for{' '}
            {LEGAL_INVENTORY_SUMMARY.pendingAssetProvenance} files, and{' '}
            {LEGAL_INVENTORY_SUMMARY.unresolvedPackageRecords} package records still need metadata
            or legal-text review. Broader distribution remains blocked until the exact release
            artifact, bundled native libraries and fonts, ownership, applicable terms, and the final
            notice bundle receive owner and legal review.
          </Text>
        </SettingsSection>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40 },
  gap: { marginTop: 20 },
  text: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 12 },
});
