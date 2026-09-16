const { withGradleProperties } = require('@expo/config-plugins');

// Building the patched React Native source loads substantially more Gradle/Kotlin classes than
// the default prebuilt-AAR path. Expo's generated 512 MiB Metaspace limit is too small for the
// release build, so keep the existing heap/flags and raise only the exhausted bounded pool.
const FALLBACK_GRADLE_JVM_ARGS = '-Xmx2048m -XX:MaxMetaspaceSize=1024m';
const METASPACE_ARG = '-XX:MaxMetaspaceSize=1024m';

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
    .filter((argument) => argument && !argument.startsWith('-XX:MaxMetaspaceSize='));
  existing.value = [...preserved, METASPACE_ARG].join(' ');
}

module.exports = function withGradleJvmMemory(config) {
  return withGradleProperties(config, (cfg) => {
    applyGradleJvmMemory(cfg.modResults);
    return cfg;
  });
};

module.exports.applyGradleJvmMemory = applyGradleJvmMemory;
