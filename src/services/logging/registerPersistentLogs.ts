import { initPersistentLogs } from './fileLogSink';

// Entry-point side effect: attach synchronously, then clean/restore the prior file in the bounded
// queue. Foreground boot observes the same promise and surfaces a cleanup failure to the user.
void initPersistentLogs().catch(() => {
  // The file sink itself cannot safely report its own initialization failure. Foreground boot
  // presents the retained finite issue. A headless-only process stays silent and does not treat an
  // unverified legacy file as successfully cleaned; foreground remediation remains required.
});
