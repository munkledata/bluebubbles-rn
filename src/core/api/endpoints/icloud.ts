import { z } from 'zod/v4';
import type { HttpClient } from '../http';

/**
 * iMessage/iCloud account endpoints (F-#8). The server exposes the Mac's signed-in Apple account
 * and its send-from aliases via the Private API helper:
 *   GET  /api/v1/icloud/account          → this account's info + aliases
 *   POST /api/v1/icloud/account/alias    → set which vetted alias new chats send FROM
 * Lenient parsing: scalars may be null and `aliases` may be absent — normalize to [].
 */
export const AccountInfo = z
  .object({
    appleId: z.string().nullish(),
    displayName: z.string().nullish(),
    /** The alias new outgoing chats are sent from (a phone number or email). */
    activeAlias: z.string().nullish(),
    /** All aliases on the account. */
    aliases: z
      .array(z.string())
      .nullish()
      .transform((a) => a ?? []),
    /** The subset Apple has vetted/enabled for sending (null when undeterminable). */
    vettedAliases: z.array(z.string()).nullish(),
    loginStatusMessage: z.string().nullish(),
  })
  .loose();
export type AccountInfo = z.infer<typeof AccountInfo>;

/** GET /api/v1/icloud/account — the signed-in account + its aliases. */
export function getAccountInfo(http: HttpClient): Promise<AccountInfo> {
  return http.get('/icloud/account', AccountInfo);
}

const SetAliasResult = z.object({ activeAlias: z.string().nullish() }).loose();
export type SetAliasResult = z.infer<typeof SetAliasResult>;

/** POST /api/v1/icloud/account/alias — set the active send-from alias. */
export function setActiveAlias(http: HttpClient, alias: string): Promise<SetAliasResult> {
  return http.post('/icloud/account/alias', SetAliasResult, { json: { alias } });
}
