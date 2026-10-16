import {
  MIN_NEW_BACKUP_PASSPHRASE_LENGTH,
  type NewBackupPassphraseIssue,
} from '@/services/backup/backupSchema';

/**
 * The one message for a new backup passphrase that fails the rules, shared by local export and
 * server backup slots so the two cannot drift apart (review M210).
 */
export function passphraseIssueMessage(issue: NewBackupPassphraseIssue): string {
  return issue === 'too-short'
    ? `Choose a passphrase of at least ${MIN_NEW_BACKUP_PASSPHRASE_LENGTH} characters.`
    : 'Choose a less common passphrase.';
}
