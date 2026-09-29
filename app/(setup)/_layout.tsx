import { ExperimentalStack } from 'expo-router';

/** Keep first-run history inside one root route so completion is a single root replacement. */
export default function SetupLayout(): React.JSX.Element {
  return <ExperimentalStack screenOptions={{ headerShown: false }} />;
}
