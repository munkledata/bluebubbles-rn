/**
 * Shared setup for the 'node' jest project. Registered as `setupFilesAfterEnv` in jest.config.js.
 * A nested database transaction fails fast here (see transactionNesting.ts) instead of hanging the
 * suite until Jest's timeout.
 */
import { installTransactionNestingDetector } from './transactionNesting';

installTransactionNestingDetector();
