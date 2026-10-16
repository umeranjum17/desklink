// Expo SDK 57's expo-module-gradle-plugin treats AGP's built-in Kotlin as
// active unless `android.builtInKotlin` is explicitly false, and then never
// applies `kotlin-android` — but RN 0.86's version catalog pins AGP 8.12,
// which has no built-in Kotlin, so module configuration dies with "Could not
// find method kotlinOptions()". `expo prebuild` regenerates
// android/gradle.properties on every run, so the property is set here, inside
// the mod pass that generates that file, rather than edited into it by hand.
const { withGradleProperties } = require('expo/config-plugins');

module.exports = (config) => withGradleProperties(config, (mod) => {
    mod.modResults = mod.modResults.filter(
        (item) => item.type !== 'property' || item.key !== 'android.builtInKotlin');
    mod.modResults.push({ type: 'property', key: 'android.builtInKotlin', value: 'false' });
    return mod;
});
