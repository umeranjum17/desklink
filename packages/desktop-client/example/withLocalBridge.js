// The reference bridge deliberately serves plaintext on a private network.
// This exception belongs to the example, never to the client package's plugin.
const { withAndroidManifest, withInfoPlist, AndroidConfig } = require('expo/config-plugins');
module.exports = (config) => {
    config = withAndroidManifest(config, (mod) => {
        AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults).$['android:usesCleartextTraffic'] = 'true';
        return mod;
    });
    // The lab posts its evidence reports to a plaintext host URL.
    return withInfoPlist(config, (mod) => {
        mod.modResults.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true };
        return mod;
    });
};
