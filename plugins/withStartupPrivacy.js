const { withMainApplication } = require('@expo/config-plugins');

const LOADER = '    loadReactNative(this)';
const WRAPPER = 'expo.modules.gatorscreensecurity.GatorStartupPrivacy.run';
const PROTECTED_LOADER = [
  `    ${WRAPPER}(BuildConfig.DEBUG) {`,
  '      loadReactNative(this)',
  '    }',
].join('\n');
const WEBSOCKET_POLICY = [
  '    WebSocketModule.setCustomClientBuilder { builder ->',
  '      builder.followRedirects(false)',
  '      builder.followSslRedirects(false)',
  '    }',
].join('\n');

// Deliberately support only the reviewed SDK 57 method, with or without our
// WebSocket plugin. Fail on template drift instead of wrapping a commented,
// conditional, duplicated, or unrelated load call. Do not reindent other plugins.
function startupMethod(loader, withWebSocket) {
  return [
    '  override fun onCreate() {',
    '    super.onCreate()',
    ...(withWebSocket ? [WEBSOCKET_POLICY] : []),
    '    DefaultNewArchitectureEntryPoint.releaseLevel = try {',
    '      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())',
    '    } catch (e: IllegalArgumentException) {',
    '      ReleaseLevel.STABLE',
    '    }',
    loader,
    '    ApplicationLifecycleDispatcher.onApplicationCreate(this)',
    '  }',
  ].join('\n');
}

function applyStartupPrivacy(source, language = 'kt') {
  if (language !== 'kt') {
    throw new Error('withStartupPrivacy supports only Kotlin MainApplication files');
  }
  const normalized = source.replace(/\r\n?/g, '\n');
  const count = (value) => normalized.split(value).length - 1;
  if (
    normalized.includes('/*') ||
    normalized.includes('"""') ||
    count('override fun onCreate()') !== 1 ||
    count('loadReactNative(this)') !== 1 ||
    count(WRAPPER) > 1 ||
    !normalized.includes(
      '\nimport com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative\n',
    )
  ) {
    throw new Error('withStartupPrivacy found unsupported or duplicate startup code');
  }
  const code = normalized.replace(/\/\/[^\n]*/g, '');
  for (const withWebSocket of [false, true]) {
    const protectedMethod = startupMethod(PROTECTED_LOADER, withWebSocket);
    if (code.includes(protectedMethod) && normalized.includes(protectedMethod)) return normalized;
    const originalMethod = startupMethod(LOADER, withWebSocket);
    if (
      count(WRAPPER) === 0 &&
      code.includes(originalMethod) &&
      normalized.includes(originalMethod)
    ) {
      return normalized.replace(originalMethod, protectedMethod);
    }
  }
  throw new Error(
    'withStartupPrivacy could not find the reviewed unconditional SDK 57 startup method',
  );
}

function withStartupPrivacy(config) {
  return withMainApplication(config, (cfg) => {
    cfg.modResults.contents = applyStartupPrivacy(cfg.modResults.contents, cfg.modResults.language);
    return cfg;
  });
}

module.exports = withStartupPrivacy;
module.exports.applyStartupPrivacy = applyStartupPrivacy;
