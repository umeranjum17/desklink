import { configDefaults, defineConfig, type Plugin } from 'vitest/config';

/**
 * The example app installs its own dependency tree under its own node_modules.
 * The root project must not reach into it: its `react-native` ships untranspilable
 * Flow source and its own copy of React makes a second, conflicting copy. Every
 * spec that renders the example app already mocks these packages, so pointing
 * them at an empty module keeps the bundled tree out of collection entirely.
 */
const EXAMPLE_ONLY = [
    'react-native',
    'react-native-safe-area-context',
    'react-native-webrtc',
    'expo-clipboard',
    'expo-modules-core',
];

function unbundledExampleDeps(): Plugin {
    const ids = new Set(EXAMPLE_ONLY.map((name) => `\0unbundled:${name}`));
    return {
        name: 'desklink:unbundled-example-deps',
        enforce: 'pre',
        resolveId: (id) => (ids.has(id) ? id : EXAMPLE_ONLY.includes(id) ? `\0unbundled:${id}` : null),
        load: (id) => (ids.has(id) ? 'export default {};' : null),
    };
}

export default defineConfig({
    plugins: [unbundledExampleDeps()],
    resolve: { dedupe: ['react'] },
    test: { exclude: [...configDefaults.exclude, '**/dist/**', '**/engine/target/**'] },
    // Metro defines this global for an app; the client's sources read it.
    define: { __DEV__: 'false' },
});