// The two react-native exports the hook reads, for the hook client in `mac-soak-flow.html` (a browser has no react-native).
export const AppState = { addEventListener: () => ({ remove() {} }) };
export const Platform = { OS: 'web' };
