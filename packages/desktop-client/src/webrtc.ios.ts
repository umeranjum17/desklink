/**
 * The app's `react-native-webrtc`, evaluated on the first call rather than
 * with the package: importing the package must not pull the native WebRTC
 * libraries into the application's first paint. Metro bundles an inline
 * `require` and runs it only when reached; a require by a name built at
 * runtime would not be bundled at all.
 */
export function requireWebRTC(): unknown {
    return require('react-native-webrtc');
}
