import { installReactNativeExceptionPrivacyBoundary } from './reactNativeExceptionPrivacy';

// Entry-point side effect: this must evaluate before every other index.js registration and before
// expo-router renders. Keeping it outside app/_layout.tsx also covers headless process starts.
installReactNativeExceptionPrivacyBoundary();
