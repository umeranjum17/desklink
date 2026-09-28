import * as React from 'react';
import { Keyboard, StyleSheet, TextInput, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import { RTCView } from 'react-native-webrtc';
import type { DesktopViewProps } from './DesktopView';
import { keyboardDelta } from './keyboardDelta';
import { desktopInputEnabled, emitDesktopKeyboard, getDesktopSize, getDesktopStream, markDesktopPresented, nativeDesklink, observeDesktopSurface, registerDesktopView } from './native.ios';

type Point = { x: number; y: number };
type Gesture = { start: Point; last: Point; time: number; mode: 'pending' | 'hover' | 'pan' | 'armed' | 'drag' | 'two' | 'scroll' | 'pinch' | 'spent'; span: number; focus: Point };

export function DesktopView({ sessionId, style, placeholder, accessibilityLabel, keyboardClearance = 0, gestures = 'desktop' }: DesktopViewProps) {
    const [revision, refresh] = React.useReducer((n: number) => n + 1, 0);
    const [bounds, setBounds] = React.useState({ width: 0, height: 0 });
    const [size, setSize] = React.useState(() => getDesktopSize(sessionId) ?? { width: 0, height: 0 });
    const [keyboardHeight, setKeyboardHeight] = React.useState(0);
    const [zoom, setZoom] = React.useState(1);
    const [offset, setOffset] = React.useState<Point>({ x: 0, y: 0 });
    const [cursor, setCursor] = React.useState<Point | null>(null);
    const [keyboardText, setKeyboardText] = React.useState('');
    const keyboardTextRef = React.useRef('');
    const input = React.useRef<TextInput>(null);
    const captured = React.useRef(false);
    const gesture = React.useRef<Gesture | null>(null);
    const longPress = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastTap = React.useRef<{ time: number; at: Point; point: Point } | null>(null);
    const [enabled, setEnabled] = React.useState(() => desktopInputEnabled(sessionId));
    const stream = getDesktopStream(sessionId);
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

    const visibleHeight = Math.max(1, bounds.height - (keyboardHeight ? keyboardHeight + keyboardClearance : 0));
    const fit = size.width && size.height ? Math.min(bounds.width / size.width, visibleHeight / size.height) : 1;
    const scale = fit * zoom;
    const pictureWidth = size.width * scale;
    const pictureHeight = size.height * scale;
    const originX = (bounds.width - pictureWidth) / 2 + offset.x;
    const originY = (visibleHeight - pictureHeight) / 2 + offset.y;
    const point = (x: number, y: number, clamp = false): Point | null => {
        if (!size.width || !size.height || !scale) return null;
        const px = Math.floor((x - originX) / scale);
        const py = Math.floor((y - originY) / scale);
        if (!clamp && (px < 0 || py < 0 || px >= size.width || py >= size.height)) return null;
        return { x: Math.max(0, Math.min(size.width - 1, px)), y: Math.max(0, Math.min(size.height - 1, py)) };
    };
    const send = (control: Record<string, unknown>) => { if (sessionId) nativeDesklink.sendControl(sessionId, JSON.stringify(control)); };
    const pointer = (phase: string, at: Point, button?: number) => {
        send({ kind: 'pointer', phase, x: at.x, y: at.y, ...(button ? { button } : {}) });
        // A device screen shows the touch itself; a cursor would be a second finger that lies.
        if (gestures !== 'device') setCursor(at);
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
        const at = { x: touches[0].locationX, y: touches[0].locationY };
        // A device screen is pressed, not pointed at: the finger lands with the
        // button down. A tap is the same press lifted without moving, and a
        // hold holds — there is no long press to arm.
        if (gestures === 'device') {
            const from = point(at.x, at.y);
            gesture.current = { start: at, last: at, time: Date.now(), mode: from ? 'drag' : 'spent', span: 0, focus: at };
            if (from) pointer('down', from, 1);
            return;
        }
        gesture.current = { start: at, last: at, time: Date.now(), mode: 'pending', span: 0, focus: at };
        stopTimer();
        longPress.current = setTimeout(() => {
            if (gesture.current?.mode === 'pending' && point(at.x, at.y)) gesture.current.mode = 'armed';
        }, 500);
    };
    const move = (event: GestureResponderEvent) => {
        if (!enabled) return;
        const g = gesture.current;
        if (!g) return;
        const touches = event.nativeEvent.touches;
        if (touches.length === 2) {
            stopTimer();
            const center = focus(touches);
            const distance = span(touches);
            if (g.mode !== 'two' && g.mode !== 'pinch' && g.mode !== 'scroll') {
                if (g.mode === 'drag') send({ kind: 'release_all' });
                g.mode = 'two'; g.span = distance; g.focus = center; g.start = center;
                return;
            }
            if (g.mode === 'two') {
                if (Math.abs(distance - g.span) > 12) g.mode = 'pinch';
                else if (Math.hypot(center.x - g.start.x, center.y - g.start.y) > 8) g.mode = 'scroll';
            }
            if (g.mode === 'pinch' && g.span) {
                setZoom((value) => Math.max(1, Math.min(2.5 / fit, value * distance / g.span)));
            } else if (g.mode === 'scroll') {
                send({ kind: 'wheel', dx: -(center.x - g.focus.x) / scale / 120, dy: -(center.y - g.focus.y) / scale / 120 });
            }
            g.span = distance; g.focus = center;
            return;
        }
        if (touches.length !== 1 || g.mode === 'spent' || g.mode === 'two' || g.mode === 'pinch' || (g.mode === 'scroll' && gestures !== 'browser')) return;
        const at = { x: touches[0].locationX, y: touches[0].locationY };
        if (g.mode === 'pending' && Math.hypot(at.x - g.start.x, at.y - g.start.y) > 8) {
            stopTimer();
            // A page scrolls under one finger; the desktop's pointer rides along
            // so the scroll lands where the finger is.
            if (gestures === 'browser') {
                g.mode = 'scroll';
                const under = point(at.x, at.y);
                if (under) pointer('move', under);
            } else g.mode = zoom > 1 ? 'pan' : 'hover';
        }
        if (g.mode === 'scroll') {
            // Content follows the finger: moving it up scrolls the page down.
            send({ kind: 'wheel', dx: -(at.x - g.last.x) / scale / 120, dy: -(at.y - g.last.y) / scale / 120 });
            g.last = at;
            return;
        }
        if (g.mode === 'pan') {
            const dx = at.x - g.last.x;
            const dy = at.y - g.last.y;
            setOffset((current) => ({
                x: Math.max(-Math.max(0, (pictureWidth - bounds.width) / 2), Math.min(Math.max(0, (pictureWidth - bounds.width) / 2), current.x + dx)),
                y: Math.max(-Math.max(0, (pictureHeight - visibleHeight) / 2), Math.min(Math.max(0, (pictureHeight - visibleHeight) / 2), current.y + dy)),
            }));
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
    const onLayout = (event: LayoutChangeEvent) => setBounds(event.nativeEvent.layout);
    return <View style={[styles.surface, style]} onLayout={onLayout} accessibilityLabel={accessibilityLabel}
        onStartShouldSetResponder={() => enabled} onMoveShouldSetResponder={() => enabled}
        onResponderGrant={start} onResponderMove={move} onResponderRelease={end}
        onResponderTerminate={() => { stopTimer(); if (gesture.current?.mode === 'drag') send({ kind: 'release_all' }); gesture.current = null; }}>
        {sessionId && stream && size.width > 0 && size.height > 0 ?
            <RTCView pointerEvents="none" streamURL={stream.toURL()} objectFit="contain" style={{ position: 'absolute', left: originX, top: originY, width: pictureWidth, height: pictureHeight }}
                onDimensionsChange={(event) => { if (event.nativeEvent.width > 0 && event.nativeEvent.height > 0) markDesktopPresented(sessionId); }} /> : placeholder}
        {cursor && <View pointerEvents="none" style={[styles.cursor, { left: originX + (cursor.x + 0.5) * scale, top: originY + (cursor.y + 0.5) * scale }]} />}
        <TextInput ref={input} style={styles.input} value={keyboardText} onChangeText={changeText} autoCorrect={false} autoCapitalize="none" submitBehavior="submit"
            onSubmitEditing={() => { send({ kind: 'key', name: 'Enter', modifiers: [], down: true }); send({ kind: 'key', name: 'Enter', modifiers: [], down: false }); }} />
    </View>;
}

const styles = StyleSheet.create({
    surface: { backgroundColor: '#000', overflow: 'hidden' },
    cursor: { position: 'absolute', width: 12, height: 18, backgroundColor: '#fff', borderWidth: 2, borderColor: '#000', transform: [{ rotate: '-30deg' }] },
    input: { position: 'absolute', width: 1, height: 1, opacity: 0, left: 0, bottom: 0 },
});
