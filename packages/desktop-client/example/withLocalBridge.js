// The reference bridge deliberately serves plaintext on a private network.
// This exception belongs to the example, never to the client package's plugin.
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');
module.exports = (config) => withAndroidManifest(config, (mod) => {
    AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults).$['android:usesCleartextTraffic'] = 'true';
    return mod;
});
