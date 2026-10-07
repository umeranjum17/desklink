import { requireNativeView } from 'expo';
import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { desktopAvailable } from './native';
import type { GestureProfile } from './protocol';

/** Room at each edge of the view, in points; a missing edge is 0. */
export type EdgeInsets = { top?: number; left?: number; bottom?: number; right?: number };

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
     * controls, in points. While the keyboard is up the picture sits above both,
     * following the keyboard as it moves.
     */
    keyboardClearance?: number;
    /**
     * What the system covers at each edge of the view — status and navigation
     * bars, a camera cutout, the home indicator — in points, as a safe-area
     * library reports it. The picture still reaches under these edges, but it
     * starts and pans inside them: its top-left corner first shows just inside,
     * and every edge of the desktop can be brought into the uncovered part.
     */
    insets?: EdgeInsets;
    /**
     * Which touch meaning the surface uses: a desktop pointer, a browser page
     * (one finger scrolls), or a device screen (one finger presses and drags).
     */
    gestures?: GestureProfile;
    /**
     * Cover the view in every orientation, cropping the overflowing axis,
     * instead of fitting the portrait width. Off by default.
     */
    cover?: boolean;
    /**
     * Where the picture ended, in the view's own points, whenever it moves.
     * A wide desktop on a tall screen leaves a band under the picture; this is
     * how an application lays its own controls into that band instead of
     * guessing the desktop's aspect.
     */
    onPictureFrame?: (frame: { top: number; height: number }) => void;
}

interface NativeSurfaceProps {
    sessionId: string | null;
    style?: StyleProp<ViewStyle>;
    accessible?: boolean;
    accessibilityLabel?: string;
    keyboardClearance?: number;
    /** `insets` as top, left, bottom, right. */
    insets?: number[];
    gestures?: GestureProfile;
    cover?: boolean;
}

// The Expo view is resolved at module load; on a platform without it the
// component is absent and `DesktopView` falls back to its placeholder.
const NativeSurface: React.ComponentType<NativeSurfaceProps> | null = desktopAvailable
    ? (requireNativeView('Desklink', 'DesklinkSurface') as React.ComponentType<NativeSurfaceProps>)
    : null;

/**
 * The live desktop surface.
 *
 * It renders the picture and the pointer and owns the gestures, and nothing
 * else: the surrounding chrome, the start state and the return navigation
 * belong to the application, which mounts this wherever it wants the desktop
 * to appear.
 */
export function DesktopView({ sessionId, style, placeholder, accessibilityLabel, keyboardClearance = 0, insets, gestures = 'desktop', cover = false }: DesktopViewProps) {
    if (NativeSurface == null || sessionId == null) {
        return (
            <View style={[styles.surface, style]}>
                {placeholder}
            </View>
        );
    }
    return <NativeSurface style={[styles.surface, style]} sessionId={sessionId} accessible={accessibilityLabel !== undefined} accessibilityLabel={accessibilityLabel} keyboardClearance={keyboardClearance}
        insets={[insets?.top ?? 0, insets?.left ?? 0, insets?.bottom ?? 0, insets?.right ?? 0]} gestures={gestures} cover={cover} />;
}

const styles = StyleSheet.create({
    surface: {
        backgroundColor: '#000',
        overflow: 'hidden',
    },
});
