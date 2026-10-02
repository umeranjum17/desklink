/**
 * The smallest app that shows a desktop served by `desklink-host bridge`.
 *
 * It takes the bridge URL, token included, from a launch argument on iOS,
 * which iOS places in the app's user defaults, or from a connection link on
 * Android (`desklink-example://connect?url=…&report=…`):
 *
 *   xcrun simctl launch <device> dev.desklink.example -desklinkUrl 'ws://HOST:PORT/desktop?token=…'
 *
 * Control is enabled as soon as the picture is live, so a tap on the picture
 * clicks the desktop. The picture fills the screen inside its safe area. The
 * key row arms Ctrl, Shift, Alt and Meta, and Copy brings the desktop's
 * clipboard over with its confirmation. The hidden accessibility status
 * carries `testID="desklink-status"` for test/ios-flow.mjs to read through
 * the simulator's accessibility tree.
 */
import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Linking, Platform, Pressable, Settings, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    ClipboardConfirmation,
    DesktopView,
    ModifierKeys,
    useDesktopSession,
    type SessionEvent,
    type SessionSnapshot,
    type Signaling,
} from '@desklink/react-native';

function connectionLink(link: string | null): { url: string; report: string | null; key: string } | null {
    if (!link) return null;
    try {
        const parsed = new URL(link);
        const url = parsed.searchParams.get('url');
        return url ? { url, report: parsed.searchParams.get('report'), key: link } : null;
    } catch { return null; }
}

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
 * What the status message tells the person. It uses status, frame readiness and
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
    const [connection, setConnection] = React.useState(() => {
        const url: unknown = Platform.OS === 'ios' ? Settings.get('desklinkUrl') : null;
        return typeof url === 'string' ? { url, report: null as string | null, key: url } : null;
    });
    React.useEffect(() => {
        if (Platform.OS === 'ios') return;
        let active = true;
        void Linking.getInitialURL().then((link) => { if (active) setConnection(connectionLink(link)); });
        const subscription = Linking.addEventListener('url', ({ url }) => setConnection(connectionLink(url)));
        return () => { active = false; subscription.remove(); };
    }, []);
    if (!connection) return <View style={[styles.root, styles.idle]}><StatusBar hidden /><Text style={styles.messageText}>Open a desktop connection link to connect.</Text></View>;
    return (
        <SafeAreaProvider>
            <ConnectedDesktop key={connection.key} url={connection.url} report={connection.report} />
        </SafeAreaProvider>
    );
}

function ConnectedDesktop({ url, report }: { url: string; report: string | null }) {
    const startedAt = React.useRef(Date.now());
    const presentedAt = React.useRef<number | null>(null);
    // The picture fills the screen but starts and pans inside the status bar,
    // camera cutout and home indicator, so none of them covers the desktop's corner.
    const insets = useSafeAreaInsets();
    const signaling = React.useRef<ReturnType<typeof bridgeSignaling> | null>(null);
    const desktop = useDesktopSession({
        authorize: async () => {
            // A reconnect gets a fresh socket: the bridge ends a session whose socket closed.
            signaling.current?.close();
            signaling.current = bridgeSignaling(url);
            return { signaling: signaling.current, session: {} };
        },
    });
    const { status } = desktop.snapshot;
    const [copyError, setCopyError] = React.useState<string | null>(null);

    async function copy() {
        setCopyError(null);
        try {
            await desktop.copyRemoteToLocal(async (text) => {
                if (!await Clipboard.setStringAsync(text)) throw new Error('The phone refused the clipboard write.');
            });
        } catch (error) {
            setCopyError(error instanceof Error ? error.message : String(error));
        }
    }

    React.useEffect(() => {
        void desktop.connect();
        return () => signaling.current?.close();
    }, []);
    React.useEffect(() => {
        desktop.setInputEnabled(status === 'live');
    }, [status]);
    React.useEffect(() => {
        if (status !== 'live') return;
        presentedAt.current ??= Date.now();
        if (!report) return;
        let stopped = false;
        // Optional evidence collection stays off the visible desktop surface.
        const sample = async () => {
            try {
                const stats = await desktop.getStats();
                if (!stopped) await fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), startedAt: startedAt.current, presentedAt: presentedAt.current, stats }) });
            } catch { /* Evidence collection never interrupts a desktop session. */ }
        };
        void sample();
        const timer = setInterval(() => { void sample(); }, 1000);
        return () => { stopped = true; clearInterval(timer); };
    }, [status, desktop.getStats, report]);

    return (
        <View style={styles.root}>
            <StatusBar hidden />
            <DesktopView sessionId={desktop.nativeId} style={StyleSheet.absoluteFill} insets={insets} accessibilityLabel="desktop" />
            <View pointerEvents="none" style={styles.bar}>
                <Text testID="desklink-status" style={styles.status}>
                    {statusText(desktop.snapshot)}
                </Text>
            </View>
            {status !== 'live' && <View pointerEvents="none" style={styles.message}>
                <Text style={styles.messageText}>{statusText(desktop.snapshot)}</Text>
            </View>}
            <View pointerEvents="none" style={styles.confirmation}>
                <ClipboardConfirmation transfer={desktop.clipboard} />
                {copyError && <Text accessibilityLiveRegion="polite" style={styles.copyLabel}>{copyError}</Text>}
            </View>
            <View style={styles.keys}>
                <ModifierKeys modifiers={desktop.modifiers} onTap={desktop.tapModifier} style={styles.row} />
                <Pressable testID="desklink-copy" accessibilityRole="button" onPress={() => void copy()} style={styles.copy}>
                    <Text style={styles.copyLabel}>Copy</Text>
                </Pressable>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    idle: { alignItems: 'center', justifyContent: 'center' },
    bar: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
    status: { color: 'transparent', fontSize: 1 },
    message: { position: 'absolute', left: 0, right: 0, bottom: 48, alignItems: 'center' },
    messageText: { color: '#fff', fontSize: 16 },
    confirmation: { minHeight: 48, justifyContent: 'center' },
    keys: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: 24, flexDirection: 'row', backgroundColor: 'rgba(22, 23, 26, 0.94)' },
    row: { flex: 1, backgroundColor: 'transparent' },
    copy: { margin: 8, minHeight: 44, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center', backgroundColor: '#2b2d33' },
    copyLabel: { color: '#c9ccd3', fontSize: 15, fontWeight: '500' },
    // Below the status bar and any notch.
    toast: { top: 64 },
});
