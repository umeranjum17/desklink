import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: { exclude: [...configDefaults.exclude, '**/dist/**', '**/engine/target/**'] },
    // Metro defines this global for an app; the client's sources read it.
    define: { __DEV__: 'false' },
});
