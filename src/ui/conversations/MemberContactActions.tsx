import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { logger } from '@core/secure';
import { memberAddressKind } from '@utils';
import {
  callMember,
  canViewMemberContact,
  copyMemberAddress,
  emailMember,
  openMemberContact,
} from '@/services/memberContactActions';
import { useTheme } from '../theme';
import { showExternalOpenFailure } from '../toast/external-open-feedback';

interface MemberContactActionsProps {
  /** The participant's display name, for the buttons' accessibility labels. */
  name: string;
  address: string;
  /** The linked device contact's id, or null when the handle has no linked contact. */
  contactSourceId: string | null;
}

/**
 * Copy, Call, Email and Contacts actions for one chat participant (chat details). Call appears only
 * for a dialable number and Email only for an email address; a business short code gets Copy alone.
 * Every handoff that the phone refuses shows the shared "Couldn't open this outside Gator" notice.
 */
export function MemberContactActions({
  name,
  address,
  contactSourceId,
}: MemberContactActionsProps): React.JSX.Element {
  const theme = useTheme();
  const kind = memberAddressKind(address);
  const canView = canViewMemberContact(contactSourceId);

  const handOff = (action: () => Promise<boolean>): void => {
    void action().then(
      (opened) => {
        if (!opened) showExternalOpenFailure();
      },
      () => showExternalOpenFailure(),
    );
  };

  const actions: { key: string; label: string; accessibilityLabel: string; onPress: () => void }[] =
    [
      {
        key: 'copy',
        label: 'Copy',
        accessibilityLabel: `Copy ${name}’s address`,
        onPress: () =>
          void copyMemberAddress(address).then((copied) => {
            // The address itself is never logged.
            if (!copied) logger.warn('chat details: copying a participant address failed');
          }),
      },
    ];
  if (kind === 'phone') {
    actions.push({
      key: 'call',
      label: 'Call',
      accessibilityLabel: `Call ${name}`,
      onPress: () => handOff(() => callMember(address)),
    });
  }
  if (kind === 'email') {
    actions.push({
      key: 'email',
      label: 'Email',
      accessibilityLabel: `Email ${name}`,
      onPress: () => handOff(() => emailMember(address)),
    });
  }
  if (canView || kind !== 'other') {
    actions.push({
      key: 'contact',
      label: canView ? 'View Contact' : 'Add to Contacts',
      accessibilityLabel: canView ? `View ${name} in Contacts` : `Add ${name} to Contacts`,
      onPress: () => handOff(() => openMemberContact({ address, contactSourceId })),
    });
  }

  return (
    <View style={styles.row}>
      {actions.map((action) => (
        <Pressable
          key={action.key}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel}
          onPress={action.onPress}
          hitSlop={6}
        >
          <Text style={[styles.action, { color: theme.color.tint }]}>{action.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 18,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  action: { fontSize: 15, paddingVertical: 6 },
});
