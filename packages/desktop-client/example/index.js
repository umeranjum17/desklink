import { registerRootComponent } from 'expo';
import { LogBox } from 'react-native';
import App from './App';

// Tester builds load their bundle from this machine's Metro on a per-run
// port, which the Expo devtools probe never finds: its one
// "Cannot connect to Expo CLI" warning would otherwise sit as a dev toast
// over every tester-facing screen. The probe is a developer convenience the
// demo never uses, so the demo ignores exactly that warning and no others.
LogBox.ignoreLogs(['Cannot connect to Expo CLI']);

registerRootComponent(App);
