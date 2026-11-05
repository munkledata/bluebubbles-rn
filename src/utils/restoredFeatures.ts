import { IMESSAGE_RESTORED_FEATURES, type ServerInfo } from '@core/models';

/**
 * One line for Settings → About and Server Management: are the restored iMessage features (group
 * reactions, edits, effects and the rest) available from this server? A newer server lists every
 * `supports_imessage_*` switch, all false until they are turned on on the Mac; an older server lists
 * none of them. "—" until the server's details have loaded.
 */
export function restoredIMessageFeaturesLabel(info: ServerInfo | null | undefined): string {
  if (!info) return '—';
  if (IMESSAGE_RESTORED_FEATURES.some((feature) => info[feature] === true)) return 'On';
  if (IMESSAGE_RESTORED_FEATURES.some((feature) => info[feature] === false)) return 'Off';
  return 'Not on this server';
}
