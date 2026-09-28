import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { GestureProfile } from './protocol';

export interface DesktopViewProps {
    /** The session handle from `useDesktopSession`. */
    sessionId: string | null;
    style?: StyleProp<ViewStyle>;
    /** Shown until the first desktop frame has actually rendered. */
    placeholder?: React.ReactNode;
    /** What a screen reader calls the surface. */
    accessibilityLabel?: string;
    /**
     * Space the application keeps free above the phone's keyboard for its own
     * controls, in points. While the keyboard is up the picture sits above both.
     */
    keyboardClearance?: number;
    /**
     * Which touch meaning the surface uses: a desktop pointer, a browser page
     * (one finger scrolls), or a device screen (one finger presses and drags).
     */
    gestures?: GestureProfile;
}

/**
 * The live desktop surface, in a browser.
 *
 * The picture, the gestures and the keyboard belong to the session's own web
 * implementation, so this is a mount point: it hands that session a DOM element
 * and gets out of the way. The platform module is imported when a surface is
 * actually mounted rather than at module load, so an application that never
 * opens a desktop does not carry one in its first paint.
 */
export function DesktopView({ sessionId, style, placeholder, accessibilityLabel, keyboardClearance = 0, gestures = 'desktop' }: DesktopViewProps) {
    const mounted = React.useCallback(
        (node: unknown) => {
            const element = (node as HTMLElement | null) ?? null;
            if (sessionId === null) return;
            void import('./native').then((platform) => {
                if (element === null || !platform.desktopAvailable) return;
                platform.attachSurface(sessionId, element, gestures);
            });
        },
        [sessionId],
    );

    React.useEffect(() => {
        if (sessionId === null) return;
        void import('./native').then((platform) => platform.setGestures(sessionId, gestures));
    }, [sessionId, gestures]);

    React.useEffect(() => {
        if (sessionId === null) return;
        void import('./native').then((platform) => platform.setKeyboardClearance(sessionId, keyboardClearance));
    }, [sessionId, keyboardClearance]);

    return (
        <View style={[styles.surface, style]} accessibilityLabel={accessibilityLabel}>
            {sessionId === null ? placeholder : <div ref={mounted} style={styles.dom} />}
        </View>
    );
}

const styles = StyleSheet.create({
    surface: { backgroundColor: '#000', overflow: 'hidden' },
    dom: { position: 'absolute', inset: 0 },
});
