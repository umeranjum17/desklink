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
    isLoopbackTcpCandidate,
    useDesktopSession,
    type SessionEvent,
    type SessionSnapshot,
    type TcpTransport,
} from '@desklink/react-native';
import { bridgeSignaling } from './bridgeSignaling';

/** The height of controls a tablet's band takes, in points: status, a 96 pt modifier row and three 96 pt keys. */
const DECK_TALL = 560;
/** The shortest edge that makes a screen a tablet's rather than a phone's. */
const TABLET_MIN = 500;

function connectionLink(link: string | null): { url: string; report: string | null; cover: boolean; keyboardFit: boolean; tcpRelay: string | null; relayOnly: boolean; key: string } | null {
    if (!link) return null;
    try {
        const parsed = new URL(link);
        const url = parsed.searchParams.get('url');
        // A demo journey opts the picture into covering the view (`cover=1`)
        // instead of fitting the portrait width; anywhere else it is off.
        // `tcpRelay` carries the desktop over the app's own relay link instead
        // of a forward (a lab WebSocket byte relay); `relayOnly=1` keeps only the
        // relayed TCP candidate, simulating a phone with no other route.
        return url ? { url, report: parsed.searchParams.get('report'), cover: parsed.searchParams.get('cover') === '1', keyboardFit: false, tcpRelay: parsed.searchParams.get('tcpRelay'), relayOnly: parsed.searchParams.get('relayOnly') === '1', key: link } : null;
    } catch { return null; }
}

/**
 * A generic lab byte relay over WebSocket: one socket per `open()` stream,
 * binary messages each way. The relay dials the engine's loopback TCP port on
 * the host; the kit's listener feeds the phone end. Product-neutral: plain
 * bytes, no app or link names on the wire.
 */
export function wsTcpTransport(relayUrl: string): TcpTransport {
    return {
        open: () =>
            new Promise((resolve, reject) => {
                const socket = new WebSocket(relayUrl);
                socket.binaryType = 'arraybuffer';
                const handlers = new Set<(data: Uint8Array) => void>();
                let settled = false;
                socket.onopen = () => {
                    if (settled) return;
                    settled = true;
                    resolve({
                        write: (data) => {
                            if (socket.readyState === WebSocket.OPEN) socket.send(data);
                        },
                        onData: (handler) => {
                            handlers.add(handler);
                            return () => handlers.delete(handler);
                        },
                        close: () => socket.close(),
                    });
                };
                socket.onerror = () => {
                    if (!settled) {
                        settled = true;
                        reject(new Error('the relay is unreachable'));
                    }
                };
                socket.onclose = () => {
                    if (!settled) {
                        settled = true;
                        reject(new Error('the relay closed'));
                    }
                };
                socket.onmessage = (message) => {
                    const data = message.data;
                    if (data instanceof ArrayBuffer) handlers.forEach((handler) => handler(new Uint8Array(data)));
                    else if (typeof data === 'string') handlers.forEach((handler) => handler(base64ToBytes(data)));
                };
            }),
    };
}

/** Base64 to bytes, for text frames a relay may send instead of binary. */
function base64ToBytes(text: string): Uint8Array {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const values = new Uint8Array(128).fill(255);
    for (let index = 0; index < chars.length; index += 1) values[chars.charCodeAt(index)] = index;
    const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
    const length = Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0);
    const out = new Uint8Array(Math.max(0, length));
    let at = 0;
    for (let index = 0; index + 3 < clean.length + 1; index += 4) {
        const a = values[clean.charCodeAt(index)] ?? 0;
        const b = values[clean.charCodeAt(index + 1)] ?? 0;
        const c = clean[index + 2] === '=' ? 0 : (values[clean.charCodeAt(index + 2)] ?? 0);
        const d = clean[index + 3] === '=' ? 0 : (values[clean.charCodeAt(index + 3)] ?? 0);
        if (at < out.length) out[at] = ((a << 2) | (b >> 4)) & 0xff;
        if (at + 1 < out.length) out[at + 1] = ((b << 4) | (c >> 2)) & 0xff;
        if (at + 2 < out.length) out[at + 2] = ((c << 6) | d) & 0xff;
        at += 3;
    }
    return out;
}

/**
 * A lab counterfactual for a relay-only phone: keep only the relayed TCP
 * candidate (the engine's loopback offer, rewritten to the kit's listener by
 * the session) and strip anything else from SDP offers, so ICE can only use
 * the relayed route. Never on in the app itself; the journey link asks for it.
 */
export function keepRelayCandidateOnly(event: SessionEvent): SessionEvent | null {
    if (event.kind === 'candidate') {
        return isLoopbackTcpCandidate(event.candidate.candidate) ? event : null;
    }
    if (event.kind === 'description') {
        const sdp = event.description.sdp
            .split(/\r?\n/)
            .filter((line) => {
                const body = line.startsWith('a=candidate:') ? line.slice(2) : line;
                return !body.startsWith('candidate:') || isLoopbackTcpCandidate(body);
            })
            .join('\r\n');
        return { ...event, description: { ...event.description, sdp } };
    }
    return event;
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
                case 'never-connected':
                    return 'Can’t reach your desktop from this network.';
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
        // A demo journey opts the picture into covering the view
        // (`-desklinkCover 1` at launch), mirroring the Android deep link's
        // `cover=1`; anywhere else it is off.
        const coverSetting: unknown = Platform.OS === 'ios' ? Settings.get('desklinkCover') : null;
        // A journey that checks the picture against a keyboard can ask the app
        // to shrink its surface the way a consumer with a keyboard-avoiding
        // screen does (`-desklinkKeyboardFit 1` at launch); off by default, so
        // the reference app keeps the whole screen.
        const keyboardFitSetting: unknown = Platform.OS === 'ios' ? Settings.get('desklinkKeyboardFit') : null;
        // A relay-only lab journey carries the desktop over the app's own link
        // (`-desklinkTcpRelay <ws-url> -desklinkRelayOnly 1` at launch),
        // mirroring the Android deep link's `tcpRelay`/`relayOnly`.
        const tcpRelaySetting: unknown = Platform.OS === 'ios' ? Settings.get('desklinkTcpRelay') : null;
        const relayOnlySetting: unknown = Platform.OS === 'ios' ? Settings.get('desklinkRelayOnly') : null;
        // Lab evidence: where the session posts its stats (`-desklinkReport
        // <url>`), mirroring the Android deep link's `report`.
        const reportSetting: unknown = Platform.OS === 'ios' ? Settings.get('desklinkReport') : null;
        return typeof url === 'string'
            ? { url, report: typeof reportSetting === 'string' ? reportSetting : null, cover: coverSetting === '1' || coverSetting === 'true' || coverSetting === 1, keyboardFit: keyboardFitSetting === '1' || keyboardFitSetting === 'true' || keyboardFitSetting === 1, tcpRelay: typeof tcpRelaySetting === 'string' ? tcpRelaySetting : null, relayOnly: relayOnlySetting === '1' || relayOnlySetting === 'true' || relayOnlySetting === 1, key: url }
            : null;
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
            <ConnectedDesktop key={connection.key} url={connection.url} report={connection.report} cover={connection.cover} keyboardFit={connection.keyboardFit} tcpRelay={connection.tcpRelay} relayOnly={connection.relayOnly} />
        </SafeAreaProvider>
    );
}

function ConnectedDesktop({ url, report, cover, keyboardFit, tcpRelay, relayOnly }: { url: string; report: string | null; cover: boolean; keyboardFit: boolean; tcpRelay: string | null; relayOnly: boolean }) {
    const startedAt = React.useRef(Date.now());
    const root = React.useRef<View>(null);
    const presentedAt = React.useRef<number | null>(null);
    // The picture fills the screen but starts and pans inside the status bar,
    // camera cutout and home indicator, so none of them covers the desktop's corner.
    const insets = useSafeAreaInsets();
    const signaling = React.useRef<ReturnType<typeof bridgeSignaling> | null>(null);
    // A relay journey carries the desktop over the app's own link: the
    // transport below, through the journey's relay URL. Anywhere else the
    // session keeps its forward-based loopback route.
    const relay = React.useMemo(() => (tcpRelay ? wsTcpTransport(tcpRelay) : null), [tcpRelay]);
    // Lab evidence of the relay-only simulation: every dropped candidate.
    const droppedNonRelay = React.useRef(0);
    const droppedNonRelayOut = React.useRef(0);
    const desktop = useDesktopSession({
        authorize: async () => {
            // A fresh authorization needs an open carrier; the bridge may retain
            // the old session briefly after its previous socket closes.
            signaling.current?.close();
            // Lab marker: the kit has loaded its native module by now (the
            // dynamic import resolves before authorize runs), while ICE has
            // not started yet. The lab drops the guest uplink on this mark
            // and the session waits below, so ICE gathers with no route.
            if (report !== null && relayOnly) {
                void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), authorizing: true }) })
                    .catch(() => undefined);
                await new Promise(wait => setTimeout(wait, 3000));
            }
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
                    // every field, so it is stripped before parsing. Port 9 is
                    // ICE's throwaway discard, not a listener; ephemeral ports
                    // live above 1024.
                    const fields = line.replace(/^a=/, '').trim().split(/\s+/);
                    if (fields[2]?.toLowerCase() !== 'tcp') continue;
                    const port = Number(fields[5]);
                    if (!Number.isInteger(port) || port < 1024) continue;
                    void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), loopbackTcpPort: port }) })
                        .catch(() => undefined);
                }
            }, relayOnly ? (event) => {
                // Lab inventory: every candidate line the engine offers, kept or
                // dropped, so the run can prove the relay-only path. Lab only.
                if (report !== null) {
                    const offered = event.kind === 'candidate'
                        ? [event.candidate.candidate]
                        : event.kind === 'description'
                            ? event.description.sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate'))
                            : [];
                    for (const line of offered) {
                        void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), offered: line }) })
                            .catch(() => undefined);
                    }
                    if (event.kind === 'description') {
                        void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), offeredSdp: event.description.sdp }) })
                            .catch(() => undefined);
                    }
                }
                const kept = keepRelayCandidateOnly(event);
                if (kept === null) droppedNonRelay.current += 1;
                return kept;
            } : undefined, relayOnly ? (method, params) => {
                // Lab inventory of what the phone sends: the answer and its
                // own candidates. Posted raw; the lab redacts nothing since
                // these never leave the host. Non-relay locals never reach
                // the engine either: without that, the engine validates a
                // reflexive path from the phone's own checks and nominates
                // around the relay.
                if (report === null) return;
                if (method === 'session.description' || method === 'session.candidate') {
                    void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), sent: method, params }) })
                        .catch(() => undefined);
                }
            } : undefined, relayOnly ? (method, params) => {
                // The engine must not learn a phone route either: drop every
                // local candidate that is not the relayed TCP one, so no
                // reflexive path can form around the relay.
                if (method !== 'session.candidate') return params;
                const line = typeof params.candidate === 'string' ? params.candidate : '';
                if (isLoopbackTcpCandidate(line)) return params;
                droppedNonRelayOut.current += 1;
                return null;
            } : undefined);
            await signaling.current.open;
            return {
                signaling: signaling.current,
                session: relay ? { tcpTransport: relay } : {
                    // The example runs over a plain adb-reverse forward in the
                    // harness, which is TCP only: ask for the engine's loopback
                    // route so the picture can reach the phone at all.
                    loopbackTcp: true,
                },
            };
        },
    });
    const { status } = desktop.snapshot;
    // Lab evidence of the relay-only run: every status change, so the run can
    // prove the picture never fell to `reconnecting` while the relay carried it.
    const statusPosts = React.useRef(0);
    React.useEffect(() => {
        if (report === null || !relayOnly) return;
        const seq = ++statusPosts.current;
        void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), seq, statusChange: status }) })
            .catch(() => undefined);
    }, [status, report, relayOnly]);
    const [copyError, setCopyError] = React.useState<string | null>(null);
    // Where the picture ended: on a tall screen the deck fills the band under
    // it, so the screen is controls rather than empty space.
    const [pictureBottom, setPictureBottom] = React.useState(0);
    const [screen, setScreen] = React.useState({ width: 0, height: 0 });
    // With `-desklinkKeyboardFit 1` the desktop shortens to a band when the
    // keyboard is asked for, the way a consumer's keyboard-avoiding screen
    // makes room: the picture must pan inside what is left, not snap back.
    const [keyboardBand, setKeyboardBand] = React.useState(false);
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
    useJourney(root, status === 'live');
    React.useEffect(() => {
        if (status === 'live') presentedAt.current ??= Date.now();
        else if (!relayOnly) return;
        if (!report) return;
        let stopped = false;
        // Optional evidence collection stays off the visible desktop surface.
        const sample = async () => {
            try {
                const stats = await desktop.getStats();
                const tcp = await desktop.getTcpTransportStats().catch(() => null);
                if (!stopped) await fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), startedAt: startedAt.current, presentedAt: presentedAt.current, stats, tcp, droppedNonRelay: droppedNonRelay.current, droppedNonRelayOut: droppedNonRelayOut.current, statusSeq: statusPosts.current }) });
            } catch { /* Evidence collection never interrupts a desktop session. */ }
        };
        void sample();
        const timer = setInterval(() => { void sample(); }, 1000);
        return () => { stopped = true; clearInterval(timer); };
    }, [status, desktop.getStats, desktop.getTcpTransportStats, report, relayOnly]);
    // A terminal state posts once, so a failed lab run still says why.
    React.useEffect(() => {
        if (!report) return;
        if (status !== 'failed' && status !== 'ended') return;
        void fetch(report, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at: Date.now(), terminal: status, failure: desktop.snapshot.failure }) })
            .catch(() => undefined);
    }, [status, report]);

    return (
        <View ref={root} style={styles.root} onLayout={(event) => setScreen(event.nativeEvent.layout)}>
            <StatusBar hidden />
            {keyboardFit
                // A consumer whose screen makes room for the keyboard shortens
                // the surface; the picture must pan inside what is left rather
                // than snap back to the desktop's top-left corner.
                ? <View pointerEvents="box-none" style={keyboardBand ? [styles.band, { bottom: undefined, height: Math.max(1, screen.height * 0.3) }] : styles.band}>
                    <DesktopView sessionId={desktop.nativeId} style={StyleSheet.absoluteFill} insets={insets} accessibilityLabel="desktop"
                        cover={cover} onPictureFrame={(frame) => setPictureBottom(frame.top + frame.height)} />
                </View>
                : <DesktopView sessionId={desktop.nativeId} style={StyleSheet.absoluteFill} insets={insets} accessibilityLabel="desktop"
                    cover={cover} onPictureFrame={(frame) => setPictureBottom(frame.top + frame.height)} />}

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
                <Pressable testID="desklink-keyboard" accessibilityRole="button"
                    onPress={() => { if (keyboardFit) setKeyboardBand(true); desktop.showKeyboard(); }}
                    style={[styles.copy, tallDeck && styles.copyTall, sideways && styles.copyRow]}>
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

type Fiber = { tag: number; child: Fiber | null; sibling: Fiber | null; return: Fiber | null; memoizedProps: any; stateNode: any };

/**
 * Debug builds only: `-desklinkJourney http://HOST:PORT/` makes the live app
 * fetch scripted steps from test/ios-device-flow.mjs and run each through the
 * desktop view's own touch and text handlers and the app's own buttons. It is
 * for a real device no test runner can drive; nothing physical touches the
 * screen, so it proves everything after the gesture recognizer, not the glass.
 */
function useJourney(root: React.RefObject<View | null>, live: boolean) {
    React.useEffect(() => {
        const at: unknown = __DEV__ && live && Platform.OS === 'ios' ? Settings.get('desklinkJourney') : null;
        if (typeof at !== 'string') return;
        let stopped = false, typed = '';
        // What the app renders now: up to React's current tree, then down it.
        const find = (match: (props: any) => boolean): any => {
            let fiber: Fiber | null = (root.current as any)?.__internalInstanceHandle ?? null;
            while (fiber?.return) fiber = fiber.return;
            const stack = fiber?.tag === 3 ? [fiber.stateNode.current as Fiber] : [];
            while (stack.length) {
                const node = stack.pop()!;
                if (node.memoizedProps && match(node.memoizedProps)) return node.stateNode?.canonical?.currentProps ?? node.memoizedProps;
                if (node.sibling) stack.push(node.sibling);
                if (node.child) stack.push(node.child);
            }
            throw new Error('nothing on screen matches the step');
        };
        const run = (step: { touch?: 'start' | 'move' | 'end'; points?: [number, number][]; text?: string; press?: string }) => {
            if (step.touch) {
                const surface = find((props) => props.accessibilityLabel === 'desktop' && props.onResponderGrant);
                const touches = (step.touch === 'end' ? [] : step.points ?? []).map(([x, y]) => ({ locationX: x, locationY: y, timestamp: Date.now() }));
                ({ start: surface.onResponderGrant, move: surface.onResponderMove, end: surface.onResponderRelease })[step.touch]({ nativeEvent: { touches } });
            } else if (step.text !== undefined) {
                // The hidden field keeps a short suffix of what was typed, as the keyboard would.
                const next = typed + step.text;
                typed = next.length > 64 ? next.slice(-32) : next;
                find((props) => props.onChangeText && props.submitBehavior === 'submit').onChangeText(next);
            } else if (step.press) {
                find((props) => props.testID === step.press && props.onPress).onPress();
            }
            return { done: Date.now() };
        };
        const abort = new AbortController();
        void (async () => {
            let reply: unknown = { ready: Date.now() };
            while (!stopped) {
                try {
                    const response = await fetch(at, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reply), signal: abort.signal });
                    const step = await response.json();
                    if (stopped || step === null) return;
                    reply = run(step);
                } catch (error) { reply = { error: String(error) }; await new Promise((wait) => setTimeout(wait, 1000)); }
            }
        })();
        return () => { stopped = true; abort.abort(); };
    }, [live, root]);
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#000' },
    // The keyboard-fit journey's band: the desktop's own height, or a short
    // band once the keyboard is asked for.
    band: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden' },
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
