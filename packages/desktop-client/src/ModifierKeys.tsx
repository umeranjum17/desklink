import * as React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import type { StickyModifier, StickyModifiers, StickyState } from './stickyModifiers';

export interface ModifierKeysProps {
    /** The session's `modifiers`. */
    modifiers: StickyModifiers;
    /** The session's `tapModifier`. */
    onTap: (name: StickyModifier) => void;
    style?: StyleProp<ViewStyle>;
}

const LABELS: Record<StickyModifier, string> = { Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Meta' };
/** What a screen reader says for each state; "once" is the latch the user sees. */
export const STATE_NAMES: Record<StickyState, string> = { off: 'off', once: 'latched', lock: 'locked' };

/**
 * The sticky modifier keys as a row the user can read at a glance.
 *
 * Off is an outlined dark key, latched is a filled key, and locked is a
 * filled key with a white rim and a bar under its label, so the three differ
 * in shape as well as colour. The row carries its own backing, so it reads
 * the same over a light desktop as over a dark one.
 */
export function ModifierKeys({ modifiers, onTap, style }: ModifierKeysProps) {
    return (
        <View style={[styles.row, style]}>
            {(['Control', 'Shift', 'Alt', 'Meta'] as const).map((name) => {
                const state = modifiers[name];
                return (
                    <Pressable
                        key={name}
                        testID={`desklink-key-${name}`}
                        accessibilityRole="button"
                        accessibilityLabel={LABELS[name]}
                        accessibilityState={{ selected: state !== 'off' }}
                        accessibilityValue={{ text: STATE_NAMES[state] }}
                        onPress={() => onTap(name)}
                        style={[styles.key, state === 'off' ? styles.off : styles.on, state === 'lock' && styles.lock]}
                    >
                        <Text style={state === 'off' ? styles.offLabel : styles.onLabel}>{LABELS[name]}</Text>
                        <View style={[styles.bar, state === 'lock' && styles.barShown]} />
                    </Pressable>
                );
            })}
        </View>
    );
}

export const KEY_COLORS = {
    backing: 'rgba(22, 23, 26, 0.94)',
    off: '#2b2d33',
    offLabel: '#c9ccd3',
    on: '#2563eb',
    onLabel: '#ffffff',
};

const styles = StyleSheet.create({
    row: { flexDirection: 'row', gap: 8, padding: 8, backgroundColor: KEY_COLORS.backing },
    key: { minWidth: 56, minHeight: 44, paddingHorizontal: 12, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
    off: { backgroundColor: KEY_COLORS.off, borderColor: '#4b4e57' },
    on: { backgroundColor: KEY_COLORS.on, borderColor: KEY_COLORS.on },
    lock: { borderColor: '#ffffff' },
    offLabel: { color: KEY_COLORS.offLabel, fontSize: 15, fontWeight: '500' },
    onLabel: { color: KEY_COLORS.onLabel, fontSize: 15, fontWeight: '700' },
    bar: { marginTop: 3, width: 18, height: 3, borderRadius: 2, backgroundColor: 'transparent' },
    barShown: { backgroundColor: '#ffffff' },
});
