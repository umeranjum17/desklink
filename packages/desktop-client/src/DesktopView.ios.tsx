import * as React from 'react';
import { Image, Keyboard, StyleSheet, TextInput, View, type GestureResponderEvent, type LayoutChangeEvent, type ViewProps } from 'react-native';
import pointerArrow from './pointer.png';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { DesktopViewProps } from './DesktopView';
import { hardwareKey, type HardwareKey } from './hardwareKeys';
import { keyboardDelta } from './keyboardDelta';
import { requireWebRTC } from './webrtc.ios';
import { desktopInputEnabled, emitDesktopKeyboard, getDesktopSize, getDesktopStream, markDesktopPresented, nativeDesklink, observeDesktopSurface, registerDesktopView } from './native.ios';

type Point = { x: number; y: number };
type Gesture = { stamp: number; start: Point; last: Point; time: number; mode: 'pending' | 'letterbox' | 'hover' | 'pan' | 'armed' | 'drag' | 'two' | 'scroll' | 'pinch' | 'spent'; span: number; focus: Point };

/** Wheel detents accumulate in these steps and never send more than this at once. */
const MIN_WHEEL_STEP = 0.05;
const MAX_WHEEL_STEP = 10;
/** Desktop pixels one wheel detent stands for. */
const PIXELS_PER_DETENT = 120;
/** The closest the picture can be zoomed: view points per desktop pixel. */
const MAX_SCALE = 2.5;
/** Where the cursor mark's tip sits inside the mark, in points. */
const CURSOR_HOTSPOT = 3;

type NativeEvent<T> = { nativeEvent: T };
type PointerEvent = { phase: 'hover' | 'down' | 'move' | 'up' | 'cancel'; x: number; y: number; buttons?: number; timestamp?: number };
type WheelEvent = { phase: 'begin' | 'move' | 'end'; dx: number; dy: number; x: number; y: number };
type InputViewProps = ViewProps & {
    enabled: boolean;
    onKey: (event: NativeEvent<HardwareKey>) => void;
    onPointer: (event: NativeEvent<PointerEvent>) => void;
    onWheel: (event: NativeEvent<WheelEvent>) => void;
};

/**
 * The package's native surface (`ios/DesklinkInputView.swift`): it reports the
 * hardware keyboard and an iPad pointer. A build without it — an app that has
 * not rebuilt its native project since updating — keeps a plain view, with
 * touch and the on-screen keyboard only.
 */
function loadInputView(): React.ComponentType<InputViewProps> | null {
    try {
        return requireOptionalNativeModule('DesklinkInput') ? requireNativeViewManager<InputViewProps>('DesklinkInput') : null;
    } catch {
        return null;
    }
}

/** A press's desktop button from UIKit's button mask: primary, secondary, then the middle. */
function pressedButton(mask: number): number {
    if (mask & 2) return 3;
    if (mask & 4) return 2;
    return 1;
}

/** The native video view, loaded on first render rather than with this module. */
function loadRTCView(): React.ComponentType<Record<string, unknown>> | null {
    try {
        const webrtc = requireWebRTC() as {
            RTCView?: React.ComponentType<Record<string, unknown>>;
        };
        return webrtc.RTCView ?? null;
    } catch {
        return null;
    }
}

/** An offset that the edge clamp turns into the desktop's top-left corner. */
const TOP_LEFT: Point = { x: Infinity, y: Infinity };

export function DesktopView({ sessionId, style, placeholder, accessibilityLabel, keyboardClearance = 0, insets, gestures = 'desktop' }: DesktopViewProps) {
    const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
    const [bounds, setBounds] = React.useState({ width: 0, height: 0 });
    const [size, setSize] = React.useState(() => getDesktopSize(sessionId) ?? { width: 0, height: 0 });
    const [keyboardHeight, setKeyboardHeight] = React.useState(0);
    /** Zoom over the whole-desktop fit; null fills the view, the default. */
    const [zoom, setZoom] = React.useState<number | null>(null);
    /** From the middle of the uncovered part of the view; clamped to the picture's edges when shown. */
    const [offset, setOffset] = React.useState<Point>(TOP_LEFT);
    const [cursor, setCursor] = React.useState<Point | null>(null);
    const [keyboardText, setKeyboardText] = React.useState('');
    const keyboardTextRef = React.useRef('');
    const input = React.useRef<TextInput>(null);
    const captured = React.useRef(false);
    const gesture = React.useRef<Gesture | null>(null);
    const wheel = React.useRef({ x: 0, y: 0 });
    const longPress = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastTap = React.useRef<{ time: number; at: Point; point: Point } | null>(null);
    const chordsDown = React.useRef(new Set<number>());
    /** Touch timestamps of recent trackpad or mouse presses, which the native view reports and touch leaves alone. */
    const pressStamps = React.useRef<number[]>([]);
    const pressed = React.useRef<number | null>(null);
    const [enabled, setEnabled] = React.useState(() => desktopInputEnabled(sessionId));
    const stream = getDesktopStream(sessionId);
    const RTCView = React.useMemo(loadRTCView, []);
    const InputView = React.useMemo(loadInputView, []);
    void revision;

    React.useEffect(() => {
        setEnabled(desktopInputEnabled(sessionId));
        return observeDesktopSurface(() => { refresh(); setEnabled(desktopInputEnabled(sessionId)); });
    }, [sessionId]);
    React.useEffect(() => {
        const show = Keyboard.addListener('keyboardWillShow', (event) => setKeyboardHeight(event.endCoordinates.height));
        const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardHeight(0));
        return () => { show.remove(); hide.remove(); };
    }, []);
    React.useEffect(() => {
        // A held drag belongs to the old meaning: let go of the button rather
        // than release it somewhere the finger never meant.
        const held = gesture.current;
        if (held) {
            stopTimer();
            if (held.mode === 'drag') send({ kind: 'release_all' });
            held.mode = 'spent';
        }
        flushWheel(true);
        if (gestures === 'device') setCursor(null);
        // `send` and `flushWheel` are stable per render; this runs on profile change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gestures]);
    React.useEffect(() => {
        if (!sessionId) return;
        return registerDesktopView(sessionId, {
            show: () => { if (desktopInputEnabled(sessionId)) input.current?.focus(); },
            hide: () => { input.current?.blur(); Keyboard.dismiss(); },
            capture: (value) => { captured.current = value; },
        }, {
            size: (width, height) => setSize({ width, height }),
            fit: () => { setZoom(1); setOffset({ x: 0, y: 0 }); },
        });
    }, [sessionId]);

    // The uncovered part of the view: inside what the system covers, and above the keyboard.
    const top = insets?.top ?? 0;
    const left = insets?.left ?? 0;
    const safeWidth = Math.max(1, bounds.width - left - (insets?.right ?? 0));
    const safeHeight = Math.max(1, bounds.height - top - (insets?.bottom ?? 0));
    const visibleBottom = Math.min(top + safeHeight, bounds.height - (keyboardHeight ? keyboardHeight + keyboardClearance : 0));
    const visibleHeight = Math.max(1, visibleBottom - top);
    const fit = size.width && size.height ? Math.min(safeWidth / size.width, visibleHeight / size.height) : 1;
    const defaultScale = bounds.width <= bounds.height
        ? safeWidth / size.width
        : Math.max(bounds.width / size.width, (bounds.height - top) / size.height);
    const fill = size.width && size.height ? Math.max(fit, Math.min(MAX_SCALE, defaultScale)) : 1;
    const scale = zoom === null ? fill : fit * zoom;
    /** The zoom over the whole-desktop fit the picture is at now. */
    const zoomed = fit > 0 ? scale / fit : 1;
    // A new desktop size fills the view again, and a new fill (a rotation)
    // starts again, at the desktop's top-left corner, where a page's first words are.
    React.useEffect(() => { setZoom(null); setOffset(TOP_LEFT); }, [size.width, size.height]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    React.useEffect(() => { if (zoom === null) setOffset(TOP_LEFT); }, [fill, bounds.width, bounds.height, top, left, insets?.right, insets?.bottom]);
    const pictureWidth = size.width * scale;
    const pictureHeight = size.height * scale;
    const point = (x: number, y: number, clamp = false): Point | null => {
        if (!size.width || !size.height || !scale) return null;
        const px = Math.floor((x - originX) / scale);
        const py = Math.floor((y - originY) / scale);
        if (!clamp && (px < 0 || py < 0 || px >= size.width || py >= size.height)) return null;
        return { x: Math.max(0, Math.min(size.width - 1, px)), y: Math.max(0, Math.min(size.height - 1, py)) };
    };
    /** Hold the offset to the picture's edges at a zoom level. */
    const clampOffset = (x: number, y: number, atScale: number = scale): Point => {
        const maxX = Math.max(0, (size.width * atScale - safeWidth) / 2);
        const maxY = Math.max(0, (size.height * atScale - visibleHeight) / 2);
        return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) };
    };
    // A rotation or the keyboard can leave the offset past the picture's new edges.
    const shown = clampOffset(offset.x, offset.y);
    const originX = left + (safeWidth - pictureWidth) / 2 + shown.x;
    const originY = top + (zoom === null && pictureHeight <= visibleHeight ? 0 : (visibleHeight - pictureHeight) / 2) + shown.y;
    const send = (control: Record<string, unknown>) => { if (sessionId) nativeDesklink.sendControl(sessionId, JSON.stringify(control)); };
    const flushWheel = (force: boolean) => {
        const { x, y } = wheel.current;
        if (!force && Math.abs(x) < MIN_WHEEL_STEP && Math.abs(y) < MIN_WHEEL_STEP) return;
        if (!x && !y) return;
        send({ kind: 'wheel', dx: Math.max(-MAX_WHEEL_STEP, Math.min(MAX_WHEEL_STEP, x)), dy: Math.max(-MAX_WHEEL_STEP, Math.min(MAX_WHEEL_STEP, y)) });
        wheel.current = { x: 0, y: 0 };
    };
    const pointer = (phase: string, at: Point, button?: number, mark = true) => {
        send({ kind: 'pointer', phase, x: at.x, y: at.y, ...(button ? { button } : {}) });
        // A device screen shows the touch itself; a cursor would be a second finger that lies.
        // A trackpad or mouse has the system's own pointer on screen.
        if (!mark) setCursor(null);
        else if (gestures !== 'device') setCursor(at);
    };
    const click = (at: Point, button = 1) => { pointer('down', at, button); pointer('up', at, button); };
    const stopTimer = () => { if (longPress.current) clearTimeout(longPress.current); longPress.current = null; };
    const focus = (touches: readonly { locationX: number; locationY: number }[]): Point => ({
        x: (touches[0].locationX + touches[1].locationX) / 2,
        y: (touches[0].locationY + touches[1].locationY) / 2,
    });
    const span = (touches: readonly { locationX: number; locationY: number }[]) => Math.hypot(touches[0].locationX - touches[1].locationX, touches[0].locationY - touches[1].locationY);
    const start = (event: GestureResponderEvent) => {
        if (!enabled) return;
        const touches = event.nativeEvent.touches;
        if (touches.length !== 1) return;
        // A trackpad or mouse press the native view already reported is its own.
        const stamp = touches[0].timestamp;
        if (pressStamps.current.some((pressStamp) => Math.abs(pressStamp - stamp) < 1)) { gesture.current = null; return; }
        const at = { x: touches[0].locationX, y: touches[0].locationY };
        // A device screen is pressed, not pointed at: the finger lands with the
        // button down. A tap is the same press lifted without moving, and a
        // hold holds — there is no long press to arm.
        if (gestures === 'device') {
            const from = point(at.x, at.y);
            gesture.current = { stamp, start: at, last: at, time: Date.now(), mode: from ? 'drag' : 'spent', span: 0, focus: at };
            if (from) pointer('down', from, 1);
            return;
        }
        // Off the picture there is no pointer to carry: the finger waits for a
        // second one, and one finger alone is ignored. A zoomed picture pans
        // from anywhere, clamped to its edges.
        const onPicture = point(at.x, at.y) !== null;
        gesture.current = { stamp, start: at, last: at, time: Date.now(), mode: onPicture || zoomed > 1.001 ? 'pending' : 'letterbox', span: 0, focus: at };
        stopTimer();
        longPress.current = setTimeout(() => {
            if (gesture.current?.mode === 'pending' && point(at.x, at.y)) gesture.current.mode = 'armed';
        }, 500);
    };
    const move = (event: GestureResponderEvent) => {
        if (!enabled) return;
        const g = gesture.current;
        if (!g || !scale) return;
        const touches = event.nativeEvent.touches;
        if (touches.length === 2) {
            stopTimer();
            const center = focus(touches);
            const distance = span(touches);
            if (g.mode !== 'two' && g.mode !== 'pinch' && g.mode !== 'scroll') {
                if (g.mode === 'drag') send({ kind: 'release_all' });
                if (g.mode === 'letterbox' && !touches.some((touch) => point(touch.locationX, touch.locationY))) {
                    // The letterbox is not the desktop: only a second finger
                    // on the picture starts a gesture.
                    g.mode = 'spent';
                    return;
                }
                g.mode = 'two'; g.span = distance; g.focus = center; g.start = center;
                wheel.current = { x: 0, y: 0 };
                return;
            }
            if (g.mode === 'two') {
                if (Math.abs(distance - g.span) > 12) g.mode = 'pinch';
                else if (Math.hypot(center.x - g.start.x, center.y - g.start.y) > 8) {
                    g.mode = 'scroll';
                    // The desktop scrolls whatever is under its pointer.
                    const under = point(center.x, center.y);
                    if (under) pointer('move', under);
                }
            }
            if (g.mode === 'pinch' && g.span) {
                const maxZoom = fit > 0 ? Math.max(1, MAX_SCALE / fit) : MAX_SCALE;
                const next = Math.max(1, Math.min(maxZoom, zoomed * distance / g.span));
                const applied = zoomed > 0 ? next / zoomed : 1;
                // The desktop point under the focus stays under it while the
                // offset follows the fingers, then everything clamps back.
                const nextScale = fit * next;
                const ox = originX;
                const oy = originY;
                const baseX = left + (safeWidth - size.width * nextScale) / 2;
                const baseY = top + (visibleHeight - size.height * nextScale) / 2;
                setZoom(next);
                setOffset(clampOffset(
                    center.x - (center.x - ox) * applied - baseX + (center.x - g.focus.x),
                    center.y - (center.y - oy) * applied - baseY + (center.y - g.focus.y),
                    nextScale,
                ));
            } else if (g.mode === 'scroll') {
                // Content follows the fingers: moving them up scrolls the page down.
                wheel.current.x += -(center.x - g.focus.x) / scale / PIXELS_PER_DETENT;
                wheel.current.y += -(center.y - g.focus.y) / scale / PIXELS_PER_DETENT;
                flushWheel(false);
            }
            // Undecided, the spread is measured from where the fingers landed:
            // a slow pinch crosses the slop over many small moves.
            if (g.mode !== 'two') g.span = distance;
            g.focus = center; g.last = center;
            return;
        }
        if (touches.length !== 1 || g.mode === 'spent' || g.mode === 'letterbox' || g.mode === 'two' || g.mode === 'pinch' || (g.mode === 'scroll' && gestures !== 'browser')) return;
        const at = { x: touches[0].locationX, y: touches[0].locationY };
        if (g.mode === 'pending' && Math.hypot(at.x - g.start.x, at.y - g.start.y) > 8) {
            stopTimer();
            // A page scrolls under one finger; the desktop's pointer rides along
            // so the scroll lands where the finger is.
            if (gestures === 'browser') {
                g.mode = 'scroll';
                const under = point(at.x, at.y);
                if (under) pointer('move', under);
            } else g.mode = zoom === null || zoomed > 1.001 ? 'pan' : 'hover';
        }
        if (g.mode === 'scroll') {
            // Content follows the finger: moving it up scrolls the page down.
            wheel.current.x += -(at.x - g.last.x) / scale / PIXELS_PER_DETENT;
            wheel.current.y += -(at.y - g.last.y) / scale / PIXELS_PER_DETENT;
            flushWheel(false);
            g.last = at; g.focus = at;
            return;
        }
        if (g.mode === 'pan') {
            const dx = at.x - g.last.x;
            const dy = at.y - g.last.y;
            setOffset((current) => { const from = clampOffset(current.x, current.y); return clampOffset(from.x + dx, from.y + dy); });
        }
        if (g.mode === 'armed' && Math.hypot(at.x - g.start.x, at.y - g.start.y) > 8) {
            const from = point(g.start.x, g.start.y, true);
            if (from) pointer('down', from, 1);
            g.mode = 'drag';
        }
        if (g.mode === 'hover' || g.mode === 'drag') {
            const to = point(at.x, at.y, true);
            if (to) pointer('move', to, g.mode === 'drag' ? 1 : undefined);
        }
        g.last = at;
    };
    const end = (event: GestureResponderEvent) => {
        stopTimer();
        const g = gesture.current;
        if (!g) return;
        // Leftover wheel below the send threshold still belongs to this scroll.
        if (g.mode === 'scroll') flushWheel(true);
        if (g.mode === 'two' && Date.now() - g.time < 350) {
            const at = point(g.focus.x, g.focus.y);
            if (at) click(at, 3);
            g.mode = 'spent';
        }
        // A remaining finger after a two-finger gesture must not begin a click.
        if (event.nativeEvent.touches.length > 0) { g.mode = 'spent'; return; }
        gesture.current = null;
        if (g.mode === 'drag') { const at = point(g.last.x, g.last.y, true); if (at) pointer('up', at, 1); else send({ kind: 'release_all' }); }
        else if (g.mode === 'armed') { const at = point(g.start.x, g.start.y); if (at) click(at, 3); }
        else if (g.mode === 'pending') {
            const at = point(g.start.x, g.start.y);
            if (at) {
                const prev = lastTap.current;
                const repeated = prev && Date.now() - prev.time < 350 && Math.hypot(prev.at.x - g.start.x, prev.at.y - g.start.y) < 40;
                click(repeated ? prev.point : at);
                lastTap.current = { time: Date.now(), at: g.start, point: repeated ? prev.point : at };
            }
        }
    };
    const changeText = (text: string) => {
        // Retain only a short suffix so iOS can generate deletion events while
        // autocorrect and multi-stage input still arrive as committed text.
        const { removed, added } = keyboardDelta(keyboardTextRef.current, text);
        keyboardTextRef.current = text.length > 64 ? text.slice(-32) : text;
        for (let i = 0; i < removed; i++) {
            if (captured.current && sessionId) emitDesktopKeyboard(sessionId, { key: 'Backspace' });
            else { send({ kind: 'key', name: 'Backspace', modifiers: [], down: true }); send({ kind: 'key', name: 'Backspace', modifiers: [], down: false }); }
        }
        if (added) {
            if (captured.current && sessionId) emitDesktopKeyboard(sessionId, { text: added });
            else send({ kind: 'text', text: added });
        }
        setKeyboardText(keyboardTextRef.current);
    };
    const onKey = ({ nativeEvent }: NativeEvent<HardwareKey>) => {
        if (!enabled || !sessionId) return;
        const action = hardwareKey(nativeEvent, chordsDown.current, captured.current);
        if (action === null) return;
        if ('send' in action) send(action.send);
        else emitDesktopKeyboard(sessionId, action.capture);
    };
    const onPointer = ({ nativeEvent: { phase, x, y, buttons = 0, timestamp = NaN } }: NativeEvent<PointerEvent>) => {
        if (!enabled) return;
        if (phase === 'hover') {
            const at = point(x, y);
            if (at) pointer('move', at, undefined, false);
            return;
        }
        if (phase === 'down') {
            pressStamps.current = [...pressStamps.current.slice(-7), timestamp];
            const button = pressedButton(buttons);
            // Touch may have seen this press first: it is the pointer's, not a finger's.
            const g = gesture.current;
            let held = false;
            if (g && Math.abs(g.stamp - timestamp) < 1) {
                stopTimer();
                gesture.current = null;
                if (g.mode === 'drag') {
                    const from = point(g.start.x, g.start.y, true);
                    held = button === 1;
                    if (!held && from) pointer('up', from, 1, false);
                }
            }
            // The letterbox is not the desktop: a press there does nothing.
            const at = point(x, y);
            if (!at) return;
            pressed.current = button;
            if (!held) pointer('down', at, button, false);
            return;
        }
        const button = pressed.current;
        if (button === null) return;
        const at = point(x, y, true);
        if (phase === 'move') { if (at) pointer('move', at, button, false); return; }
        pressed.current = null;
        if (at) pointer('up', at, button, false); else send({ kind: 'release_all' });
    };
    const onWheel = ({ nativeEvent: { phase, dx, dy, x, y } }: NativeEvent<WheelEvent>) => {
        if (!enabled || !scale) return;
        if (phase === 'end') { flushWheel(true); return; }
        if (phase === 'begin') {
            // The desktop scrolls whatever is under its pointer.
            const under = point(x, y);
            if (under) pointer('move', under, undefined, false);
        }
        // Content follows the fingers, as with two fingers on the screen.
        wheel.current.x += -dx / scale / PIXELS_PER_DETENT;
        wheel.current.y += -dy / scale / PIXELS_PER_DETENT;
        flushWheel(false);
    };
    const onLayout = (event: LayoutChangeEvent) => setBounds(event.nativeEvent.layout);
    const surface: ViewProps = {
        style: [styles.surface, style], onLayout, accessible: accessibilityLabel !== undefined, accessibilityLabel,
        onStartShouldSetResponder: () => enabled, onMoveShouldSetResponder: () => enabled,
        onResponderGrant: start, onResponderMove: move, onResponderRelease: end,
        onResponderTerminate: () => { stopTimer(); if (gesture.current?.mode === 'drag') send({ kind: 'release_all' }); gesture.current = null; },
    };
    const children = <>
        {sessionId && stream && RTCView && size.width > 0 && size.height > 0 ?
            <RTCView pointerEvents="none" streamURL={stream.toURL()} objectFit="contain" style={{ position: 'absolute', left: originX, top: originY, width: pictureWidth, height: pictureHeight }}
                onDimensionsChange={(event) => { if (event.nativeEvent.width > 0 && event.nativeEvent.height > 0) markDesktopPresented(sessionId); }} /> : placeholder}
        {cursor && <Image source={pointerArrow} pointerEvents="none" accessible={false} style={[styles.cursor, { left: originX + (cursor.x + 0.5) * scale - CURSOR_HOTSPOT, top: originY + (cursor.y + 0.5) * scale - CURSOR_HOTSPOT }]} />}
        <TextInput ref={input} style={styles.input} value={keyboardText} onChangeText={changeText} autoCorrect={false} autoCapitalize="none" submitBehavior="submit" accessible={false}
            onSubmitEditing={() => {
                // While the app holds a sticky modifier, Enter is the app's to
                // chord: it goes through capture like every other key, so
                // Ctrl+Enter reaches the desktop instead of typing a newline.
                if (captured.current && sessionId) emitDesktopKeyboard(sessionId, { key: 'Enter' });
                else { send({ kind: 'key', name: 'Enter', modifiers: [], down: true }); send({ kind: 'key', name: 'Enter', modifiers: [], down: false }); }
            }} />
    </>;
    return InputView
        ? <InputView {...surface} enabled={enabled} onKey={onKey} onPointer={onPointer} onWheel={onWheel}>{children}</InputView>
        : <View {...surface}>{children}</View>;
}

const styles = StyleSheet.create({
    surface: { backgroundColor: '#000', overflow: 'hidden' },
    cursor: { position: 'absolute', width: 28, height: 28 },
    input: { position: 'absolute', width: 1, height: 1, opacity: 0, left: 0, bottom: 0 },
});
