import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  DEFAULT_INBOX_FILTERS,
  type InboxFilters,
  type InboxKindFilter,
  type InboxMuteFilter,
  type InboxReadFilter,
  type InboxSenderFilter,
  type InboxServiceFilter,
} from '@core/models';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { readableTextOn, useTheme } from '../theme';

interface Choice<T extends string> {
  value: T;
  label: string;
}

const READ_CHOICES: readonly Choice<InboxReadFilter>[] = [
  { value: 'any', label: 'All' },
  { value: 'unread', label: 'Unread' },
];
const SENDER_CHOICES: readonly Choice<InboxSenderFilter>[] = [
  { value: 'any', label: 'All' },
  { value: 'known', label: 'Known' },
  { value: 'unknown', label: 'Unknown' },
];
const KIND_CHOICES: readonly Choice<InboxKindFilter>[] = [
  { value: 'any', label: 'All' },
  { value: 'direct', label: 'Direct' },
  { value: 'group', label: 'Group' },
];
const MUTE_CHOICES: readonly Choice<InboxMuteFilter>[] = [
  { value: 'any', label: 'All' },
  { value: 'unmuted', label: 'Unmuted' },
  { value: 'muted', label: 'Muted' },
];
const SERVICE_CHOICES: readonly Choice<InboxServiceFilter>[] = [
  { value: 'any', label: 'All' },
  { value: 'imessage', label: 'iMessage' },
  { value: 'sms', label: 'SMS' },
  { value: 'rcs', label: 'RCS' },
];

interface InboxFiltersSheetProps {
  visible: boolean;
  filters: InboxFilters;
  senderLocked: boolean;
  onApply: (filters: InboxFilters) => void;
  onClose: () => void;
}

/** Draft-first filter editor: Cancel writes nothing; Apply persists all five axes once. */
export function InboxFiltersSheet({
  visible,
  filters,
  senderLocked,
  onApply,
  onClose,
}: InboxFiltersSheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<InboxFilters>(() => ({ ...filters }));

  useEffect(() => {
    if (visible) setDraft({ ...filters });
  }, [filters, visible]);

  const setAxis = <K extends keyof InboxFilters>(key: K, value: InboxFilters[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const displayedSender = senderLocked ? 'known' : draft.sender;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop} accessibilityViewIsModal>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessible={false}
          testID="inbox-filter-backdrop"
        />
        <View
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, 12),
              backgroundColor: theme.color.background,
            },
          ]}
        >
          <View style={[styles.header, { borderBottomColor: theme.color.separator }]}>
            <Pressable
              onPress={onClose}
              style={styles.headerAction}
              accessibilityRole="button"
              accessibilityLabel="Cancel conversation filters"
            >
              <Text style={[styles.headerActionText, { color: theme.color.tint }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.title, { color: theme.color.label }]}>Filters</Text>
            <Pressable
              onPress={() => setDraft({ ...DEFAULT_INBOX_FILTERS })}
              style={styles.headerAction}
              accessibilityRole="button"
              accessibilityLabel="Reset conversation filters"
            >
              <Text
                style={[styles.headerActionText, styles.resetText, { color: theme.color.tint }]}
              >
                Reset
              </Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <FilterGroup
              title="Read status"
              value={draft.read}
              choices={READ_CHOICES}
              onChange={(value) => setAxis('read', value)}
            />
            <FilterGroup
              title="Sender"
              value={displayedSender}
              choices={SENDER_CHOICES}
              disabled={senderLocked}
              helper={
                senderLocked
                  ? 'Known senders are enforced by Filter Unknown Senders in Settings. Applying changes clears any saved sender filter.'
                  : 'Groups are known when at least one participant matches a contact.'
              }
              onChange={(value) => setAxis('sender', value)}
            />
            <FilterGroup
              title="Conversation"
              value={draft.kind}
              choices={KIND_CHOICES}
              onChange={(value) => setAxis('kind', value)}
            />
            <FilterGroup
              title="Notifications"
              value={draft.mute}
              choices={MUTE_CHOICES}
              onChange={(value) => setAxis('mute', value)}
            />
            <FilterGroup
              title="Service"
              value={draft.service}
              choices={SERVICE_CHOICES}
              onChange={(value) => setAxis('service', value)}
            />
          </ScrollView>

          <Pressable
            onPress={() => onApply(senderLocked ? { ...draft, sender: 'any' } : draft)}
            style={({ pressed }) => [
              styles.apply,
              { backgroundColor: theme.color.tint, opacity: pressed ? 0.75 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Apply conversation filters"
          >
            <Text style={[styles.applyText, { color: readableTextOn(theme.color.tint) }]}>
              Apply Filters
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function FilterGroup<T extends string>({
  title,
  value,
  choices,
  onChange,
  disabled = false,
  helper,
}: {
  title: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  helper?: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.group}>
      <Text style={[styles.groupTitle, { color: theme.color.label }]}>{title}</Text>
      <View style={styles.choices} accessibilityRole="radiogroup">
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <Pressable
              key={choice.value}
              disabled={disabled}
              onPress={() => onChange(choice.value)}
              style={({ pressed }) => [
                styles.choice,
                {
                  borderColor: selected ? theme.color.tint : theme.color.separator,
                  backgroundColor: selected
                    ? `${theme.color.tint}22`
                    : theme.color.secondaryBackground,
                  opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
                },
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              accessibilityLabel={`${title}, ${choice.label}`}
            >
              <Text
                style={[
                  styles.choiceText,
                  { color: selected ? theme.color.tint : theme.color.label },
                ]}
              >
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {helper ? (
        <Text style={[styles.helper, { color: theme.color.secondaryLabel }]}>{helper}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    maxHeight: '90%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: 'hidden',
  },
  header: {
    minHeight: 52,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerAction: { minWidth: 72, minHeight: 44, justifyContent: 'center' },
  headerActionText: { fontSize: 16 },
  resetText: { textAlign: 'right' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '600' },
  content: { padding: 16, gap: 22 },
  group: { gap: 8 },
  groupTitle: { fontSize: 15, fontWeight: '600' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: {
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceText: { fontSize: 15, fontWeight: '500' },
  helper: { fontSize: 12, lineHeight: 17 },
  apply: {
    minHeight: 48,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  applyText: { fontSize: 17, fontWeight: '600' },
});
