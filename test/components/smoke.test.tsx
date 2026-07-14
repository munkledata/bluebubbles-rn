import { Text } from 'react-native';
import { render } from '@testing-library/react-native';

describe('component-test toolchain smoke test', () => {
  // RNTL 14 (React 19) makes render() async — it returns a Promise of the
  // bound queries, so it must be awaited.
  it('renders a React Native <Text> node', async () => {
    const { getByText } = await render(<Text>hello</Text>);
    expect(getByText('hello')).toBeTruthy();
  });
});
