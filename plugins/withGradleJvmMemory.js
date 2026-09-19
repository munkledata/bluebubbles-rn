const { withGradleProperties } = require('@expo/config-plugins');

// Building the patched React Native source needs more than Expo's default heap for release D8
// merging and more than its default Metaspace for Gradle/Kotlin classes. Pin both bounded pools
// while preserving unrelated JVM flags whenever the ignored Android project is regenerated.
const HEAP_ARG = '-Xmx4096m';
const METASPACE_ARG = '-XX:MaxMetaspaceSize=1024m';
const FALLBACK_GRADLE_JVM_ARGS = `${HEAP_ARG} ${METASPACE_ARG}`;

function applyGradleJvmMemory(properties) {
  const matches = properties.filter(
    (item) => item.type === 'property' && item.key === 'org.gradle.jvmargs',
  );

  if (matches.length > 1) {
    throw new Error('Duplicate org.gradle.jvmargs entries; refusing an ambiguous Android build');
  }

  const existing = matches[0];
  if (!existing) {
    properties.push({
      type: 'property',
      key: 'org.gradle.jvmargs',
      value: FALLBACK_GRADLE_JVM_ARGS,
    });
    return;
  }

  if (typeof existing.value !== 'string') {
    throw new Error('org.gradle.jvmargs must be a string');
  }

  const preserved = existing.value
    .trim()
    .split(/\s+/)
    .filter(
      (argument) =>
        argument && !argument.startsWith('-Xmx') && !argument.startsWith('-XX:MaxMetaspaceSize='),
    );
  existing.value = [HEAP_ARG, ...preserved, METASPACE_ARG].join(' ');
}

module.exports = function withGradleJvmMemory(config) {
  return withGradleProperties(config, (cfg) => {
    applyGradleJvmMemory(cfg.modResults);
    return cfg;
  });
};

module.exports.applyGradleJvmMemory = applyGradleJvmMemory;
