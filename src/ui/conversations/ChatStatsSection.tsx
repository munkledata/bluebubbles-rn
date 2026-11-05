import React from 'react';
import type { ChatStats } from '@db/repositories';
import { InfoRow, NoteRow, SettingsSection } from '../primitives';

const count = (n: number): string => n.toLocaleString('en-US');

/** "Mar 3, 2024": the first stored message's date. */
function firstMessageLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Chat Details STATS: counts of what is stored on this phone. A chat's full history may not be
 * downloaded, so the note says so rather than presenting these as the chat's lifetime totals.
 * Renders nothing until the stats load, or for a chat with no stored messages.
 */
export function ChatStatsSection({
  stats,
  style,
}: {
  stats: ChatStats | null;
  style?: React.ComponentProps<typeof SettingsSection>['style'];
}): React.JSX.Element | null {
  if (!stats || stats.sent + stats.received === 0) return null;
  return (
    <SettingsSection label="STATS" style={style}>
      <InfoRow
        label="Messages"
        value={`${count(stats.sent)} sent · ${count(stats.received)} received`}
      />
      <InfoRow label="Photos" value={count(stats.photos)} />
      <InfoRow label="Videos" value={count(stats.videos)} />
      <InfoRow label="Other files" value={count(stats.otherFiles)} />
      {stats.firstMessageAt != null ? (
        <InfoRow label="First message" value={firstMessageLabel(stats.firstMessageAt)} />
      ) : null}
      <NoteRow text="Counts what is stored on this phone. Older messages that haven’t been downloaded aren’t included." />
    </SettingsSection>
  );
}
