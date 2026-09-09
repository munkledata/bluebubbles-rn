const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = realpathSync(__dirname);
const config = getDefaultConfig(projectRoot);
const projectPathHash = createHash('sha256').update(projectRoot).digest('hex');

// Expo Router's generated context includes absolute app paths. Give every checkout/copy its own
// transform-cache namespace so an isolated Android build cannot reuse another tree's route map.
// Retain Expo's own version so a future upstream cache invalidation still takes effect.
config.cacheVersion = `${config.cacheVersion}-gator-${projectPathHash}`;

module.exports = config;
