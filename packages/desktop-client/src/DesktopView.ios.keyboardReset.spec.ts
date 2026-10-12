import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const React = require('react') as typeof import('react');
    class MockTextInput extends React.Component<Record<string, unknown>> {
        measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) {
            const bottom = (globalThis as any).__viewBottom as number;
            callback(0, bottom - 1, 100, 1);
        }
        render() {
            return null;
        }
    }
    return {
        View: 'View',
        TextInput: MockTextInput,
        Image: 'Image',
        StyleSheet: { create: (styles: unknown) => styles },
        Keyboard: {
            addListener: (type: string, callback: (...args: any[]) => void) => {
                (globalThis as any).__kbListeners[type] = callback;
                return { remove() {} };
            },
        },
        useWindowDimensions: () => (globalThis as any).__windowSize,
    };
});

vi.mock('expo-modules-core', () => ({
    requireNativeViewManager: () => null,
    requireOptionalNativeModule: () => null,
}));

vi.mock('./pointer.png', () => ({ default: 'mock-pointer' }));

vi.mock('./webrtc.ios', () => ({
    requireWebRTC: () => ({ RTCView: 'RTCView' }),
}));

vi.mock('./native.ios', () => ({
    desktopInputEnabled: () => true,
    emitDesktopKeyboard: () => {},
    getDesktopSize: () => (globalThis as any).__desktopSize,
    getDesktopStream: () => ({ toURL: () => 'mock://stream' }),
    markDesktopPresented: () => {},
    nativeDesklink: { sendControl: () => {} },
    observeDesktopSurface: () => () => {},
    registerDesktopView: () => () => {},
}));

import { DesktopView } from './DesktopView.ios';

type Renderer = TestRenderer.ReactTestRenderer;

function pictureTop(renderer: Renderer): number {
    return (renderer.root.findByType('RTCView' as any).props as any).style.top;
}

function surface(renderer: Renderer): any {
    const views = renderer.root.findAllByType('View' as any);
    const found = views.find((view) => typeof (view.props as any).onLayout === 'function');
    if (!found) throw new Error('surface view with onLayout not found');
    return found;
}

function renderView(): Renderer {
    let renderer: Renderer | null = null;
    act(() => {
        renderer = TestRenderer.create(React.createElement(DesktopView as any, { sessionId: 's1' }));
    });
    if (!renderer) throw new Error('failed to render');
    return renderer;
}

/** Drive a bounds change the way a keyboard-avoiding consumer shrinking the view does. */
function layout(renderer: Renderer, width: number, height: number) {
    (globalThis as any).__viewBottom = height;
    act(() => {
        surface(renderer).props.onLayout({ nativeEvent: { layout: { width, height } } });
    });
}

function tap(renderer: Renderer, x: number, y: number) {
    const responder = surface(renderer).props;
    act(() => {
        responder.onResponderGrant({ nativeEvent: { touches: [{ timestamp: 1000, locationX: x, locationY: y }] } });
    });
    act(() => {
        responder.onResponderRelease({ nativeEvent: { touches: [] } });
    });
}

function showKeyboard(keyboardTop: number) {
    act(() => {
        (globalThis as any).__kbListeners.keyboardWillShow({ endCoordinates: { screenY: keyboardTop } });
    });
}

function hideKeyboard() {
    act(() => {
        (globalThis as any).__kbListeners.keyboardWillHide();
    });
}

function rotate(renderer: Renderer, width: number, height: number) {
    (globalThis as any).__windowSize = { width, height };
    (globalThis as any).__viewBottom = height;
    act(() => {
        renderer.update(React.createElement(DesktopView as any, { sessionId: 's1' }));
        surface(renderer).props.onLayout({ nativeEvent: { layout: { width, height } } });
    });
}

beforeEach(() => {
    (globalThis as any).__kbListeners = {};
});

describe('iOS keyboard-fit offset reset', () => {
    it('keeps the keyboard pan when a portrait consumer shrinks the view to a band', () => {
        // Portrait phone with a tall desktop: the picture is taller than the
        // view at fit, so the keyboard pans it and the offset leaves the
        // top-left corner. Shrinking the view to a ~30% band flips the
        // shrunken view's own aspect but not the window orientation.
        (globalThis as any).__windowSize = { width: 390, height: 844 };
        (globalThis as any).__desktopSize = { width: 300, height: 1000 };
        const renderer = renderView();
        layout(renderer, 390, 844);
        expect(pictureTop(renderer)).toBe(0);

        tap(renderer, 195, 700);
        showKeyboard(444);
        expect(pictureTop(renderer)).toBeLessThan(-100);

        // The consumer makes room for the keyboard by shrinking the view to a
        // band. The window stays portrait, so the picture must stay panned
        // instead of snapping back to the desktop top-left.
        layout(renderer, 390, 253);
        expect(pictureTop(renderer)).toBeLessThan(-100);
        renderer.unmount();
    });

    it('still resets the picture to the top-left on a true rotation', () => {
        // Tall desktop in portrait: the picture is taller than the view at
        // fit, so the keyboard pan is observable here too.
        (globalThis as any).__windowSize = { width: 390, height: 844 };
        (globalThis as any).__desktopSize = { width: 300, height: 1000 };
        const renderer = renderView();
        layout(renderer, 390, 844);
        expect(pictureTop(renderer)).toBe(0);

        tap(renderer, 195, 700);
        showKeyboard(444);
        expect(pictureTop(renderer)).toBeLessThan(-100);

        // A true rotation changes the window orientation: the picture starts
        // again at the desktop top-left corner.
        hideKeyboard();
        rotate(renderer, 844, 390);
        expect(pictureTop(renderer)).toBe(0);
        renderer.unmount();
    });
});
