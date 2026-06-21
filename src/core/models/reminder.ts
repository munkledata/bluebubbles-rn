/** A saved "remind me about this message" entry, backed by a Notifee trigger. */
export interface Reminder {
  id: number;
  messageGuid: string;
  chatGuid: string;
  messagePreview: string | null;
  senderName: string | null;
  scheduledFor: number;
  notificationId: string;
  createdAt: number | null;
}
