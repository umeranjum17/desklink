/**
 * The smallest app that shows a desktop served by `desklink-host bridge`.
 *
 * It takes the bridge URL, token included, from a launch argument, which iOS
 * places in the app's user defaults:
 *
 *   xcrun simctl launch <device> dev.desklink.example -desklinkUrl 'ws://HOST:PORT/desktop?token=…'
 *
 * Control is enabled as soon as the picture is live, so a tap on the picture
 * clicks the desktop. The picture fills the screen inside its safe area. The
 * status line carries `testID="desklink-status"` for test/ios-flow.mjs to read
 * through the simulator's accessibility tree.
 */
import * as React from 'react';
import { Settings, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { DesktopView, useDesktopSession, type SessionEvent, type SessionSnapshot, type Signaling } from '@desklink/react-native';

const url: unknown = Settings.get('desklinkUrl');

/** The bridge re-serves the engine's local protocol; this unwraps its events for the hook. */
function bridgeSignaling(address: string): Signaling & { close: () => void } {
    const socket = new WebSocket(address);
    const open = new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        // The address carries the pairing token, so no error ever names it.
        socket.onerror = () => reject(new Error('cannot reach the desktop host'));
    });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const handlers = new Set<(event: SessionEvent) => void>();
    let seq = 0;
    socket.onmessage = (message) => {
        const msg = JSON.parse(String(message.data));
        if (msg.id !== undefined) {
            const waiter = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error !== undefined) waiter?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
            else waiter?.resolve(msg.result);
            return;
        }
        const p = msg.params ?? {};
        let event: SessionEvent | null = null;
        if (msg.event === 'session.description') event = { kind: 'description', description: p.description, sessionId: p.sessionId };
        else if (msg.event === 'session.candidate') event = { kind: 'candidate', candidate: { candidate: p.candidate, sdpMid: p.sdpMid ?? null, sdpMLineIndex: p.sdpMLineIndex ?? null }, sessionId: p.sessionId };
        else if (msg.event === 'session.state') event = { kind: 'state', capture: p.capture, transport: p.transport, firstFrame: p.firstFrame, sessionId: p.sessionId };
        else if (msg.event === 'session.revoked') event = { kind: 'revoked', reason: p.reason, sessionId: p.sessionId };
        if (event !== null) for (const handler of handlers) handler(event);
    };
    socket.onclose = () => {
        for (const waiter of pending.values()) waiter.reject(new Error('the bridge closed'));
        pending.clear();
    };
    return {
        request: async <T,>(method: string, params?: Record<string, unknown>) => {
            await open;
            return new Promise<T>((resolve, reject) => {
                const id = ++seq;
                pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
                socket.send(JSON.stringify({ id, method, params: params ?? {} }));
            });
        },
        subscribe: (handler) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        close: () => socket.close(),
    };
}

/**
 * What the status line tells the person. It uses status, frame readiness and
 * failure code; see SessionSnapshot.failure for why raw messages stay hidden.
 */
export function statusText({ status, presented, failure }: SessionSnapshot): string {
    switch (status) {
        case 'idle':
            return '';
        case 'opening':
        case 'connecting':
            return 'Connecting…';
        case 'live':
            return presented ? 'Connected' : 'Connecting…';
        case 'reconnecting':
            return 'Can’t reach your desktop. Reconnecting…';
        case 'ended':
            return failure?.code === 'revoked' ? 'Your desktop ended this session' : 'Session ended';
        case 'failed':
            switch (failure?.code) {
                case 'transport':
                    return 'Can’t reach your desktop.';
                case 'permission':
                    return 'This phone isn’t allowed to show your desktop.';
                case 'consent':
                    return 'Screen sharing wasn’t approved on your desktop.';
                case 'no-screen':
                    return 'Your desktop has no screen to show.';
                case 'unsupported-codec':
                case 'incompatible-version':
                    return 'This app and your desktop need updating to work together.';
                case 'source-changed':
                    return 'Your desktop’s screen changed. Reconnect to continue.';
                case 'revoked':
                    return 'Your desktop ended this session';
                case 'input-unavailable':
                    return 'Your desktop can’t take control from this phone.';
                default:
                    return 'This phone can’t show your desktop.';
            }
    }
}

export default function App() {
    return (
        <SafeAreaProvider>
            <Desktop />
        </SafeAreaProvider>
    );
}

function Desktop() {
    // The picture fills the screen but starts and pans inside the status bar,
    // camera cutout and home indicator, so none of them covers the desktop's corner.
    const insets = useSafeAreaInsets();
    const signaling = React.useRef<ReturnType<typeof bridgeSignaling> | null>(null);
    const desktop = useDesktopSession({
        authorize: async () => {
            if (typeof url !== 'string') throw new Error('launch with -desklinkUrl set to the bridge URL');
            // A reconnect gets a fresh socket: the bridge ends a session whose socket closed.
            signaling.current?.close();
            signaling.current = bridgeSignaling(url);
            return { signaling: signaling.current, session: {} };
        },
    });
    const { status } = desktop.snapshot;

    React.useEffect(() => {
        void desktop.connect();
    }, []);
    React.useEffect(() => {
        desktop.setInputEnabled(status === 'live');
    }, [status]);

    return (
        <View style={styles.root}>
            <StatusBar barStyle="light-content" />
            <DesktopView sessionId={desktop.nativeId} style={StyleSheet.absoluteFill} insets={insets} accessibilityLabel="desktop" />
            <View pointerEvents="none" style={styles.bar}>
                <Text testID="desklink-status" style={styles.status}>
                    {statusText(desktop.snapshot)}
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    bar: { position: 'absolute', left: 16, right: 16, bottom: 64, minHeight: 24, alignItems: 'center' },
    status: { color: '#fff', fontSize: 15, textAlign: 'center' },
});
