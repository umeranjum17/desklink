/**
 * Opt-in config plugin: an iPad trackpad's or mouse's presses reach the
 * desktop with the button that made them — a drag selects, a secondary click
 * is a right click. It sets `UIApplicationSupportsIndirectInputEvents`, which
 * changes how every screen of the app receives that input, so the package
 * never sets it on its own. Hover, scroll and the hardware keyboard work
 * without it.
 *
 *   "plugins": ["@desklink/react-native"]
 */
module.exports = function withDesklinkPointer(config) {
    return {
        ...config,
        ios: { ...config.ios, infoPlist: { ...config.ios?.infoPlist, UIApplicationSupportsIndirectInputEvents: true } },
    };
};
