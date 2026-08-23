import type { BootIssue } from './bootStateMachine';

/**
 * Tiny cycle-free handoff from account teardown to the foreground boot owner.
 *
 * `bootstrap.ts` owns Disconnect while `foregroundBoot.ts` composes bootstrap's stage adapters.
 * Importing either module from the other would create a fragile initialization cycle, so both use
 * this leaf: the singleton installs one synchronous invalidator and teardown invokes it before its
 * first await. No credential or database value crosses this boundary.
 */

let invalidateOwner: (() => void) | null = null;
let restartOwner: (() => void) | null = null;
let issueOwner: ((issue: BootIssue) => void) | null = null;

export function installForegroundBootInvalidator(invalidator: () => void): () => void {
  invalidateOwner = invalidator;
  return () => {
    if (invalidateOwner === invalidator) invalidateOwner = null;
  };
}

export function invalidateForegroundBootForAccountTransition(): void {
  try {
    invalidateOwner?.();
  } catch {
    // Disconnect remains authoritative even if a foreground observer regresses.
  }
}

export function installForegroundBootRestarter(restarter: () => void): () => void {
  restartOwner = restarter;
  return () => {
    if (restartOwner === restarter) restartOwner = null;
  };
}

export function installForegroundBootIssueReporter(
  reporter: (issue: BootIssue) => void,
): () => void {
  issueOwner = reporter;
  return () => {
    if (issueOwner === reporter) issueOwner = null;
  };
}

/** Attach safe setup/connect degradation to the currently rendered foreground run. */
export function reportForegroundBootIssue(issue: BootIssue): boolean {
  try {
    if (!issueOwner) return false;
    issueOwner(issue);
    return true;
  } catch {
    return false;
  }
}

/** Start the post-transition run; its session stage joins the already-published account cleanup. */
export function restartForegroundBootAfterAccountTransition(): boolean {
  try {
    if (!restartOwner) return false;
    restartOwner();
    return true;
  } catch {
    // The coordinator contains its own failures; teardown completion must remain authoritative.
    return false;
  }
}
