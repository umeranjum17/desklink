// The package under test is this directory's parent, installed packed (see
// .npmrc). Its imports of the app's singletons resolve from this app, so a
// checkout's own node_modules above the package cannot hand it a second React.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const SINGLETONS = ['react', 'react-native', 'react-native-webrtc', 'expo'];
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
config.resolver.resolveRequest = (context, name, platform) => {
    const singleton = SINGLETONS.some((module) => name === module || name.startsWith(`${module}/`));
    const from = singleton ? { ...context, originModulePath: path.join(__dirname, 'index.js') } : context;
    return from.resolveRequest(from, name, platform);
};
module.exports = config;
