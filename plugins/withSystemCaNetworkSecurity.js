const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const NETWORK_SECURITY_CONFIG_REFERENCE = '@xml/network_security_config';
const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

function applySystemCaManifestPolicy(androidManifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  const attribute = 'android:networkSecurityConfig';
  const existing = application.$[attribute];

  if (existing && existing !== NETWORK_SECURITY_CONFIG_REFERENCE) {
    throw new Error(`withSystemCaNetworkSecurity: competing network security config ${existing}`);
  }

  application.$[attribute] = NETWORK_SECURITY_CONFIG_REFERENCE;
  return androidManifest;
}

function writeSystemCaNetworkSecurityConfig(platformProjectRoot) {
  const xmlDirectory = path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
  const destination = path.join(xmlDirectory, 'network_security_config.xml');
  fs.mkdirSync(xmlDirectory, { recursive: true });
  fs.writeFileSync(destination, NETWORK_SECURITY_CONFIG_XML, 'utf8');
  return destination;
}

/**
 * Freeze Gator's Android trust policy at system CAs only.
 *
 * User-installed CAs are deliberately not added as trust anchors. Cleartext remains enabled at
 * the Android layer because TLS-00 separately requires explicit in-app consent before an HTTP
 * origin can be used.
 */
function withSystemCaNetworkSecurity(config) {
  config = withAndroidManifest(config, (cfg) => {
    cfg.modResults = applySystemCaManifestPolicy(cfg.modResults);
    return cfg;
  });

  return withDangerousMod(config, [
    'android',
    (cfg) => {
      writeSystemCaNetworkSecurityConfig(cfg.modRequest.platformProjectRoot);
      return cfg;
    },
  ]);
}

module.exports = withSystemCaNetworkSecurity;
module.exports.NETWORK_SECURITY_CONFIG_REFERENCE = NETWORK_SECURITY_CONFIG_REFERENCE;
module.exports.NETWORK_SECURITY_CONFIG_XML = NETWORK_SECURITY_CONFIG_XML;
module.exports.applySystemCaManifestPolicy = applySystemCaManifestPolicy;
module.exports.writeSystemCaNetworkSecurityConfig = writeSystemCaNetworkSecurityConfig;
