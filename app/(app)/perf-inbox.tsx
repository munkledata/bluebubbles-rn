import { Redirect } from 'expo-router';
import { PerfInboxBenchmarkScreen } from '@ui/conversations/PerfInboxBenchmarkScreen';

export default function PerfInboxRoute(): React.JSX.Element {
  if (!__DEV__) return <Redirect href="/home" />;
  return <PerfInboxBenchmarkScreen />;
}
