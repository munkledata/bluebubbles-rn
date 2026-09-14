const { withMainApplication } = require('@expo/config-plugins');

const WEBSOCKET_MODULE_IMPORT = 'import com.facebook.react.modules.websocket.WebSocketModule';
const POLICY_SETTER = 'WebSocketModule.setCustomClientBuilder';
const POLICY_START = '    WebSocketModule.setCustomClientBuilder { builder ->';
const POLICY_LINES = [
  POLICY_START,
  '      builder.followRedirects(false)',
  '      builder.followSslRedirects(false)',
  '    }',
].join('\n');

function countOccurrences(source, value) {
  return source.split(value).length - 1;
}

/**
 * Disable automatic redirects in React Native's Android WebSocket handshake.
 *
 * Socket.IO supplies credentials only for the configured origin. Letting OkHttp follow a 3xx
 * would move that authenticated connection without the app's origin approval. This hook applies
 * only to React Native WebSockets; REST, uploads, and owned downloads keep their own policies.
 */
function applyWebSocketRedirectPolicy(source, language = 'kt') {
  if (language !== 'kt') {
    throw new Error('withNoWebSocketRedirects supports only Kotlin MainApplication files');
  }

  const policyMarkers = [
    WEBSOCKET_MODULE_IMPORT,
    POLICY_SETTER,
    'builder.followRedirects(false)',
    'builder.followSslRedirects(false)',
  ];
  const markerCounts = policyMarkers.map((marker) => countOccurrences(source, marker));
  const hasAnyPolicyMarker = markerCounts.some((count) => count > 0);
  const hasExactPolicy = markerCounts.every((count) => count === 1);

  if (hasAnyPolicyMarker) {
    if (
      !hasExactPolicy ||
      !source.includes(POLICY_LINES) ||
      source.indexOf(POLICY_START) > source.indexOf('loadReactNative(this)')
    ) {
      throw new Error('withNoWebSocketRedirects found a partial, duplicate, or late policy');
    }
    return source;
  }

  const importAnchor = 'import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative';
  const onCreateAnchor = '    super.onCreate()\n';
  if (
    countOccurrences(source, importAnchor) !== 1 ||
    countOccurrences(source, onCreateAnchor) !== 1
  ) {
    throw new Error('withNoWebSocketRedirects could not find the expected Expo Kotlin anchors');
  }

  return source
    .replace(importAnchor, `${WEBSOCKET_MODULE_IMPORT}\n${importAnchor}`)
    .replace(onCreateAnchor, `${onCreateAnchor}${POLICY_LINES}\n`);
}

function withNoWebSocketRedirects(config) {
  return withMainApplication(config, (cfg) => {
    cfg.modResults.contents = applyWebSocketRedirectPolicy(
      cfg.modResults.contents,
      cfg.modResults.language,
    );
    return cfg;
  });
}

module.exports = withNoWebSocketRedirects;
module.exports.applyWebSocketRedirectPolicy = applyWebSocketRedirectPolicy;
