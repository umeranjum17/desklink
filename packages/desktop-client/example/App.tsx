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
 * clipboard over with its confirmation. The status line carries
 * `testID="desklink-status"` for test/ios-flow.mjs to read through
 * the simulator's accessibility tree.
 */
import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { Linking, Platform, Pressable, ScrollView, Settings, StatusBar, StyleSheet, Text, View } from 'react-native';
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

/** The height of controls a tablet's band takes, in points: status, a 96 pt modifier row and three 96 pt keys. */
const DECK_TALL = 560;
/** The shortest edge that makes a screen a tablet's rather than a phone's. */
const TABLET_MIN = 500;

function connectionLink(link: string | null): { url: string; report: string | null; cover: boolean; key: string } | null {
    if (!link) return null;
    try {
        const parsed = new URL(link);
        const url = parsed.searchParams.get('url');
        // A demo journey opts the picture into covering the view (`cover=1`)
        // instead of fitting the portrait width; anywhere else it is off.
        return url ? { url, report: parsed.searchParams.get('report'), cover: parsed.searchParams.get('cover') === '1', key: link } : null;
    } catch { return null; }
}

/** The bridge re-serves the engine's local protocol; this unwraps its events for the hook. */
function bridgeSignaling(address: string, onEvent?: (event: SessionEvent) => void): Signaling & { close: () => void } {
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
        if (event !== null) {
            onEvent?.(event);
            for (const handler of handlers) handler(event);
        }
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
        return typeof url === 'string' ? { url, report: null as string | null, cover: false, key: url } : null;
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
            <ConnectedDesktop key={connection.key} url={connection.url} report={connection.report} cover={connection.cover} />
        </SafeAreaProvider>
    );
}

function ConnectedDesktop({ url, report, cover }: { url: string; report: string | null; cover: boolean }) {
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
            signaling.current = bridgeSignaling(url, event => {
                // The engine's loopback ICE port is ephemeral and may arrive in
                // the offer itself or as a later candidate, so a harness that
                // forwards loopback has to learn it from either.
                if (report === null) return;
                const lines = event.kind === 'candidate'
                    ? [event.candidate.candidate]
                    : event.kind === 'description'
                        ? event.description.sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate'))
                        : [];
                for (const line of lines) {
                    // SDP writes the same line with an `a=` prefix, which shifts
                    // every field, so it is stripped before parsing.
                    const fields = line.replace(/^a=/, '').trim().split(/\s+/);
                    if (fields[2]?.toLowerCase() !== 'tcp') continue;
                    const port = Number(fields[5]);
                    if (!Number.isInteger(port) || port === 0) continue;
                    void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), loopbackTcpPort: port }) })
                        .catch(() => undefined);
                }
            });
            return {
                signaling: signaling.current,
                // The example runs over a plain adb-reverse forward in the
                // harness, which is TCP only: ask for the engine's loopback
                // route so the picture can reach the phone at all.
                session: { loopbackTcp: true },
            };
        },
    });
    const { status } = desktop.snapshot;
    const [copyError, setCopyError] = React.useState<string | null>(null);
    // Where the picture ended: on a tall screen the deck fills the band under
    // it, so the screen is controls rather than empty space.
    const [pictureBottom, setPictureBottom] = React.useState(0);
    const [screen, setScreen] = React.useState({ width: 0, height: 0 });
    // A tablet's band carries tablet-sized controls and starts under the picture.
    // A phone's is left exactly as it was: its own keys, at the bottom edge.
    const tablet = Math.min(screen.width, screen.height) >= TABLET_MIN;
    const tallDeck = tablet && screen.height - (insets?.bottom ?? 0) - pictureBottom >= DECK_TALL;
    // A phone on its side is too short for the buttons one above the other: they share one row.
    const sideways = !tablet && screen.width > screen.height;

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

    /**
     * The other direction: whatever the phone copied is sent to the desktop's
     * clipboard, and the session's own confirmation pill says it arrived.
     */
    async function paste() {
        setCopyError(null);
        try {
            const text = await Clipboard.getStringAsync();
            if (!text) throw new Error('The phone’s clipboard is empty.');
            await desktop.pasteLocalToRemote(text);
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
        <View style={styles.root} onLayout={(event) => setScreen(event.nativeEvent.layout)}>
            <StatusBar hidden />
            <DesktopView sessionId={desktop.nativeId} style={StyleSheet.absoluteFill} insets={insets} accessibilityLabel="desktop"
                cover={cover} onPictureFrame={(frame) => setPictureBottom(frame.top + frame.height)} />

            <View pointerEvents="box-none" style={styles.confirmation}>
                {copyError ? (
                    <ScrollView style={styles.copyErrorScroll}>
                        <View testID="desklink-copy-error" accessible accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.copyError}>
                            <Text style={styles.copyErrorLabel}>{`Clipboard failed: ${copyError}`}</Text>
                        </View>
                    </ScrollView>
                ) : <ClipboardConfirmation transfer={desktop.clipboard} />}
            </View>
            <View pointerEvents="box-none" style={[styles.bottom, {
                // Under the picture on a tablet, where the band is the controls';
                // at the bottom of the screen on a phone, and whenever the
                // keyboard has taken the band, as tall as its controls. A height
                // measured from the deck itself would be squeezed to nothing by
                // a turn, and stay there.
                top: tallDeck ? pictureBottom : undefined,
                paddingBottom: insets.bottom,
            }]}>
            <View style={[styles.deck, tallDeck && styles.deckTall]}>
            <View pointerEvents="none" style={styles.bar}>
                <Text testID="desklink-status" style={styles.status}>
                    {statusText(desktop.snapshot)}
                </Text>
            </View>
            <ModifierKeys modifiers={desktop.modifiers} onTap={desktop.tapModifier} style={styles.row} grow={tallDeck} />
            <View style={[styles.keys, sideways && styles.keysRow]}>
                <Pressable testID="desklink-keyboard" accessibilityRole="button" onPress={() => desktop.showKeyboard()} style={[styles.copy, tallDeck && styles.copyTall, sideways && styles.copyRow]}>
                    <Text style={styles.copyLabel}>Keys</Text>
                </Pressable>
                <Pressable testID="desklink-copy" accessibilityRole="button" onPress={() => void copy()} style={[styles.copy, tallDeck && styles.copyTall, sideways && styles.copyRow]}>
                    <Text style={styles.copyLabel}>Copy</Text>
                </Pressable>
                <Pressable testID="desklink-paste" accessibilityRole="button" onPress={() => void paste()} style={[styles.copy, tallDeck && styles.copyTall, sideways && styles.copyRow]}>
                    <Text style={styles.copyLabel}>Paste</Text>
                </Pressable>
            </View>
            </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    idle: { alignItems: 'center', justifyContent: 'center' },
    messageText: { color: '#fff', fontSize: 16 },
    // The deck is one block at the bottom of the band, where thumbs are; the
    // band's slack is the single gap under the picture.
    bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, justifyContent: 'flex-end' },
    deck: { width: '100%' },
    deckTall: { flex: 1 },
    bar: { marginHorizontal: 16, marginBottom: 8, minHeight: 24, alignItems: 'center' },
    status: { color: '#fff', fontSize: 15, textAlign: 'center' },
    confirmation: { minHeight: 48, justifyContent: 'center' },
    copyErrorScroll: { maxHeight: 120, flexGrow: 0 },
    copyError: { marginHorizontal: 16, marginVertical: 8, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: '#521b24' },
    copyErrorLabel: { color: '#ffffff', fontSize: 14, fontWeight: '600' },
    keys: { backgroundColor: 'rgba(22, 23, 26, 0.94)', flexGrow: 1 },
    row: { backgroundColor: 'transparent' },
    copy: { margin: 8, minHeight: 44, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center', backgroundColor: '#2b2d33' },
    copyTall: { flexGrow: 1, minHeight: 96 },
    keysRow: { flexDirection: 'row' },
    copyRow: { flex: 1 },
    copyLabel: { color: '#c9ccd3', fontSize: 15, fontWeight: '500' },
});
