import { Redirect } from 'expo-router';
import { ColdInboxBenchmarkScreen } from '@ui/conversations/ColdInboxBenchmarkScreen';

export default function PerfInboxColdRoute(): React.JSX.Element {
  if (!__DEV__) return <Redirect href="/home" />;
  return <ColdInboxBenchmarkScreen />;
}
