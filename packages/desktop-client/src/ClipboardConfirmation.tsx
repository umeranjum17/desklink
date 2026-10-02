import * as React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { ClipboardTransfer } from './useDesktopSession';

export interface ClipboardConfirmationProps {
    /** The session's `clipboard`. */
    transfer: ClipboardTransfer | null;
    style?: StyleProp<ViewStyle>;
}

/** How long a confirmation stays up. */
export const CLIPBOARD_CONFIRMATION_MS = 1500;
const PREVIEW_CHARS = 24;

/**
 * A short pill confirming each clipboard transfer: where it went, the start of
 * the text and its size. Place it in reserved space outside the desktop
 * surface. It ignores touches and goes away on its own.
 */
export function ClipboardConfirmation({ transfer, style }: ClipboardConfirmationProps) {
    const [shown, setShown] = React.useState<ClipboardTransfer | null>(null);
    React.useEffect(() => {
        if (transfer == null) return;
        setShown(transfer);
        const timer = setTimeout(() => setShown(null), CLIPBOARD_CONFIRMATION_MS);
        return () => clearTimeout(timer);
    }, [transfer?.id]);
    if (shown == null) return null;
    return (
        <View pointerEvents="none" style={[styles.place, style]}>
            <View testID="desklink-clipboard" accessibilityLiveRegion="polite" style={styles.pill}>
                <Text numberOfLines={1} style={styles.text}>{describeTransfer(shown)}</Text>
            </View>
        </View>
    );
}

/** "Copied to phone · “first words…” · 1.2 KB" */
export function describeTransfer({ direction, text, truncated }: ClipboardTransfer): string {
    const where = direction === 'to-phone' ? 'Copied to phone' : 'Sent to desktop';
    const flat = text.replace(/\s+/g, ' ').trim();
    const chars = [...flat];
    const preview = chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : flat;
    const size = `${formatBytes(new TextEncoder().encode(text).length)}${truncated ? '+' : ''}`;
    return preview === '' ? `${where} · ${size}` : `${where} · “${preview}” · ${size}`;
}

function formatBytes(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export const PILL_COLORS = { backing: 'rgba(17, 18, 20, 0.94)', text: '#ffffff' };

const styles = StyleSheet.create({
    place: { paddingHorizontal: 16, alignItems: 'center' },
    pill: { maxWidth: '100%', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: PILL_COLORS.backing },
    text: { color: PILL_COLORS.text, fontSize: 14, fontWeight: '600' },
});
