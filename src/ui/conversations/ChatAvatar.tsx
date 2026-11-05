import React from 'react';
import type { InboxRow } from '@db/repositories';
import {
  avatarSeed,
  dedupeParticipantDetails,
  isGroupRow,
  participantAvatars,
  participantColors,
  participantList,
  primaryParticipantColor,
} from '@utils';
import { Avatar, GroupAvatar } from '../primitives';

type ChatAvatarRow = Pick<
  InboxRow,
  | 'customName'
  | 'displayName'
  | 'chatIdentifier'
  | 'style'
  | 'participantCount'
  | 'participantNames'
  | 'participantAvatars'
  | 'participantColors'
  | 'groupPhotoUri'
>;

/** How many distinct people a chat row shows: one person with two addresses counts once. */
export function chatPeopleCount(row: ChatAvatarRow): number {
  return dedupeParticipantDetails(
    participantList(row.participantNames),
    participantAvatars(row.participantAvatars),
    participantColors(row.participantColors),
  ).names.length;
}

/**
 * A chat's picture exactly as the inbox draws it: a group's own photo or member collage, or the
 * one person's photo or initials. Shared so every chat picker shows the same faces.
 */
export function ChatAvatar({
  row,
  size,
}: {
  row: ChatAvatarRow;
  size?: number;
}): React.JSX.Element {
  if (isGroupRow(row)) {
    // De-duplicated so a contact with two handles is not drawn twice in the collage.
    const parts = dedupeParticipantDetails(
      participantList(row.participantNames),
      participantAvatars(row.participantAvatars),
      participantColors(row.participantColors),
    );
    return (
      <GroupAvatar
        names={parts.names}
        uris={parts.uris}
        colors={parts.colors}
        photoUri={row.groupPhotoUri}
        size={size}
      />
    );
  }
  return (
    <Avatar
      name={avatarSeed(row)}
      uri={participantAvatars(row.participantAvatars)[0]}
      color={primaryParticipantColor(row.participantColors)}
      size={size}
    />
  );
}
