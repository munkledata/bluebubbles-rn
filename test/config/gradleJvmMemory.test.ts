import config from '../../app.config';

type GradleProperty = {
  type: 'property';
  key: string;
  value: string;
};

const { applyGradleJvmMemory } = require('../../plugins/withGradleJvmMemory') as {
  applyGradleJvmMemory: (properties: GradleProperty[]) => void;
};

describe('Android Gradle JVM memory config', () => {
  it('registers the durable managed-project config plugin', () => {
    expect(config.plugins).toContain('./plugins/withGradleJvmMemory');
  });

  it('raises the release heap and Metaspace while preserving unrelated flags', () => {
    const properties: GradleProperty[] = [
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: '-Xmx2048m -Dfile.encoding=UTF-8 -XX:MaxMetaspaceSize=512m',
      },
    ];

    applyGradleJvmMemory(properties);

    expect(properties).toEqual([
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: '-Xmx4096m -Dfile.encoding=UTF-8 -XX:MaxMetaspaceSize=1024m',
      },
    ]);
  });

  it('adds the bounded default when Expo supplies no JVM property', () => {
    const properties: GradleProperty[] = [];

    applyGradleJvmMemory(properties);

    expect(properties).toEqual([
      {
        type: 'property',
        key: 'org.gradle.jvmargs',
        value: '-Xmx4096m -XX:MaxMetaspaceSize=1024m',
      },
    ]);
  });

  it('fails closed instead of leaving an effective duplicate value', () => {
    const properties: GradleProperty[] = [
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx2048m' },
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx1024m' },
    ];

    expect(() => applyGradleJvmMemory(properties)).toThrow('Duplicate org.gradle.jvmargs entries');
  });
});
