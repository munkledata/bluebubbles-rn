/**
 * Dev-only boot composition: the crypto and database driver self-tests and the DB relaunch
 * contract. foregroundBoot.ts reaches this module only through a `__DEV__`-guarded require, which
 * Metro drops from release bundles together with everything imported here, so none of
 * src/db/devHarness, the relaunch contract or the waves ships (fix plan B-3, 2026-11-06).
 */
import { logger } from '@core/secure';
import {
  DB_DRIVER_CONTRACT_INTERNAL_FAILURE,
  runDbDriverSelfTest,
} from '@db/devHarness/dbSelfTests';
import { runCryptoSelfTest } from '../clients';
import type { BootStage } from './bootStateMachine';

export { startDevDbRelaunchContractIfRequested } from './devDbRelaunchContract';

export type OptionalFailureReporter = (
  stage: BootStage,
  code: string,
  userMessage: string | undefined,
  error?: unknown,
) => void;

/**
 * Fire-and-forget self-tests. The `GATOR_DB_CONTRACT_V3` log line is what the emulator lanes read
 * (scripts/run-android-db-contract.mjs); keep its exact shape.
 */
export function runDevSelfTests(reportOptionalFailure: OptionalFailureReporter): void {
  void runCryptoSelfTest()
    .then((result) => logger.info('[crypto] self-test', result))
    .catch((error) =>
      reportOptionalFailure('dev-self-tests', 'crypto-self-test-failed', undefined, error),
    );
  void runDbDriverSelfTest().then(
    (result) => logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(result)}`),
    () =>
      logger.info(`GATOR_DB_CONTRACT_V3 ${JSON.stringify(DB_DRIVER_CONTRACT_INTERNAL_FAILURE)}`),
  );
}
