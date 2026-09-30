import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { NativeDesklinkModule } from './native';
import type {
    ControlMessage,
    IceServerConfig,
    Permission,
    SessionFailure,
    SessionOpenRequest,
    SessionOpenResult,
    SessionSnapshot,
    Signaling,
    SurfaceGeometry,
} from './protocol';
import { PROTOCOL_VERSION, parseControlReply } from './protocol';
import {
    NO_MODIFIERS,
    afterKey,
    armedModifiers,
    tapModifier as nextModifiers,
    typeWithModifiers,
    type StickyModifier,
    type StickyModifiers,
} from './stickyModifiers';

/** How long a clipboard round trip may take before it is reported as lost. */
const CLIPBOARD_TIMEOUT_MS = 4000;

/**
 * A drop heals on its own more often than not, so the first ICE restart waits
 * out brief blips; the retries then back off. The whole schedule spans about a
 * minute, so a 30–60 s outage still recovers when the network comes back.
 */
const RESTART_AFTER_MS = 2000;
export const RESTART_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
/**
 * A heartbeat missed this long means the path is stalled, even when ICE has
 * not said so yet. Twice the engine's ping interval, with room for jitter.
 */
const STALL_AFTER_MS = 1200;
/**
 * After the session itself asks for a restart, renegotiation transients are
 * expected: ICE may flap and heartbeats may pause while the new generation
 * comes up. These are not a new outage, so they neither flip the status nor
 * trigger another restart while the window lasts.
 */
const RESTART_GRACE_MS = 2500;
/** How long a restart offer may go unanswered before the next attempt. */
const RESTART_REPLY_MS = 5000;
/**
 * Full session reopens back off across about a minute, holding at patient
 * 8 s retries: a return must never wait out a 32 s gap, and an attempt every
 * 8 s costs nothing next to a live desktop.
 */
export const REOPEN_BACKOFF_MS = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000];
/**
 * Away from the foreground this long, the path is presumed dead: ICE consent
 * lapses after about 30 s (RFC 7675), and the engine then revokes the session.
 * A return after that reopens at once instead of spending restarts on it.
 */
export const BACKGROUND_REOPEN_MS = 30_000;
/**
 * A resumed app hears what queued up while it was suspended just after it
 * hears it is active again. A revocation among it decides whether a reopen is
 * allowed at all, so the long-absence reopen waits this long for it first.
 */
const RESUME_DRAIN_MS = 750;

/** The delay before attempt `n` (0-based), or null when the schedule is spent. */
export function backoffDelay(schedule: readonly number[], attempt: number): number | null {
    return attempt < schedule.length ? schedule[attempt]! : null;
}

export type ConnectionStateName =
    | 'new'
    | 'checking'
    | 'connected'
    | 'completed'
    | 'disconnected'
    | 'failed'
    | 'closed';

/**
 * What one ICE/engine-transport state means for the session status, or null
 * when it changes nothing. `disconnected` surfaces as `reconnecting` at once —
 * event-driven, so within about a second of the drop — and `connected` moves a
 * session that had shown frames back to `live`. `failed` is terminal and is
 * handled by the failure path, not here.
 */
export function connectionStatusFor(
    state: string,
    status: SessionSnapshot['status'],
    presented: boolean,
): SessionSnapshot['status'] | null {
    switch (state) {
        case 'disconnected':
            return status === 'live' || status === 'connecting' ? 'reconnecting' : null;
        case 'connected':
        case 'completed':
            if (status !== 'reconnecting') return null;
            // Frames were never shown: this is still the first connection, not
            // a recovery, so it stays `connecting` until a frame renders.
            return presented ? 'live' : 'connecting';
        default:
            return null;
    }
}

/**
 * With no app-supplied ICE servers, ICE only finds host candidates, which need
 * a directly reachable desktop. A client with no usable route is told that
 * plainly rather than left on a spinner.
 */
const UNREACHABLE_DESKTOP =
    'The phone must reach the desktop directly, on the same network or its tailnet. Other networks need a relay route supplied by the app.';

/**
 * The engine's and host's own refusal tokens, mapped to this package's failure
 * codes. A token the engine did not send is a deliberate refusal, not a network
 * blip, so it is not treated as retryable.
 */
const OPEN_FAILURE_CODES: Record<string, SessionFailure['code']> = {
    permission: 'permission',
    'not-authorized': 'permission',
    'consent-timeout': 'consent',
    'no-screen': 'no-screen',
    'input-unavailable': 'input-unavailable',
    'unsupported-codec': 'unsupported-codec',
    encode: 'unsupported-codec',
    'incompatible-version': 'incompatible-version',
    'host-contract-mismatch': 'incompatible-version',
    'unsupported-protocol': 'incompatible-version',
    'source-changed': 'source-changed',
    transport: 'transport',
};

export function classifyOpenFailure(error: unknown): SessionFailure['code'] {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string') {
        // An engine that never answers — stopped, wedged, or unreachable — is
        // a transport problem a retry may fix, not a platform verdict.
        if (code === 'engine' || code === 'timeout') return 'transport';
        return OPEN_FAILURE_CODES[code] ?? 'platform';
    }
    // No token at all: fall back to the message, treating anything that is not a
    // permission refusal as a transport failure a retry may fix.
    const message = error instanceof Error ? error.message : '';
    return /permission|not authorized/i.test(message) ? 'permission' : 'transport';
}

/**
 * The platform module, loaded the first time a desktop is opened.
 *
 * It holds the session, the renderer and the input bridge — the largest thing in
 * this package — and most sessions never open a desktop, so it must not sit in
 * the application's initial bundle. Everything below uses this binding as it did
 * when it was a static import; the only change is when it becomes non-null.
 */
let nativeDesklink: NativeDesklinkModule | null = null;

async function loadPlatform(): Promise<boolean> {
    if (nativeDesklink !== null) return true;
    try {
        nativeDesklink = (await import('./native')).nativeDesklink;
    } catch {
        return false;
    }
    return nativeDesklink !== null;
}

export interface DesktopSessionOptions {
    /**
     * Ask the owning application for a fresh, short-lived authorization and the
     * authenticated channel to the host engine. Called for the first connection
     * and again for a reconnect: the package never reuses authority it was not
     * granted again.
     */
    authorize: () => Promise<{ signaling: Signaling; session: SessionOpenRequest }>;
    onStateChange?: (snapshot: SessionSnapshot) => void;
    onError?: (failure: SessionFailure) => void;
    /**
     * The engine refused one input message and the session carries on, such as
     * text the desktop's layout cannot type (`text-unsupported`) or too much of
     * it at once (`text-too-large`).
     */
    onRejected?: (rejection: { code: string; message: string }) => void;
}

export interface DesktopSession {
    snapshot: SessionSnapshot;
    /** The native session handle, or null when nothing is open. */
    nativeId: string | null;
    connect: () => Promise<void>;
    close: (reason?: string) => Promise<void>;
    showKeyboard: () => void;
    hideKeyboard: () => void;
    /** Copy the desktop's clipboard to the phone; the caller places it locally. */
    copyRemoteToLocal: () => Promise<{ text: string; truncated: boolean }>;
    /** Send the phone's clipboard text to the desktop. */
    pasteLocalToRemote: (text: string) => Promise<void>;
    /** Release anything the desktop is holding, without ending the session. */
    releaseHeld: () => void;
    setInputEnabled: (enabled: boolean) => void;
    /** Show the whole desktop again after the user zoomed in. */
    fitToView: () => void;
    /** Hold the screen in landscape while the desktop is shown, or follow the phone again. */
    setOrientation: (mode: 'landscape' | 'auto') => void;
    send: (message: ControlMessage) => void;
    /** Desktop modifiers as sticky keys: off, armed for the next key, or locked. */
    modifiers: StickyModifiers;
    /** Tap a sticky modifier: off, then armed for the next key, then locked, then off. */
    tapModifier: (name: StickyModifier) => void;
    /**
     * Press a named key with the armed modifiers; the returned function releases
     * it. A tap is `pressKey(name)()`. The release carries the same modifiers,
     * because the engine lets go of exactly the modifiers the message names.
     */
    pressKey: (name: string) => () => void;
}

const IDLE: SessionSnapshot = {
    status: 'idle',
    geometry: null,
    presented: false,
    failure: null,
    diagnostics: {},
};

/**
 * Desktop session lifecycle.
 *
 * The default is idle: nothing connects until the caller asks, because opening a
 * remote desktop is a user action and also because capture needs the host's
 * consent. The hook owns negotiation, readiness, reconnect and the clipboard
 * round trip; the view owns pixels and gestures.
 */
export function useDesktopSession(options: DesktopSessionOptions): DesktopSession {
    const [snapshot, setSnapshot] = useState<SessionSnapshot>(IDLE);
    const [nativeId, setNativeId] = useState<string | null>(null);
    const [modifiers, setModifiers] = useState<StickyModifiers>(NO_MODIFIERS);
    /** Read by input as it arrives, which can be faster than a render. */
    const modifiersRef = useRef<StickyModifiers>(NO_MODIFIERS);

    const opened = useRef<SessionOpenResult | null>(null);
    const signaling = useRef<Signaling | null>(null);
    const nativeRef = useRef<string | null>(null);
    const inputEnabled = useRef(false);
    const pendingClipboard = useRef(new Map<string, (reply: { text: string; truncated: boolean; error?: string }) => void>());
    /**
     * The engine's offer and candidates can beat the open result back: the
     * subscription starts before `session.open`, so anything that arrives
     * before the native session exists waits here and is replayed into it.
     */
    const pendingOffer = useRef<{ sdp: string; sessionId?: string } | null>(null);
    const pendingCandidates = useRef<Array<{ candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; sessionId?: string }>>([]);
    const attempts = useRef(0);
    /**
     * The pending reconnect attempt. It lives here rather than in the effect
     * that schedules it: that effect's own `reconnecting` update changes one of
     * its dependencies, so React would run its cleanup and cancel the retry.
     */
    const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The pending ICE-restart attempt; cancelled on recovery or failure. */
    const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** The pending stall watchdog, armed by heartbeats. */
    const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** When the last heartbeat arrived, or 0 before the first one. */
    const lastPingAt = useRef(0);
    /** Renegotiation transients are not a new outage before this time. */
    const restartGraceUntil = useRef(0);
    /** ICE-restart attempts spent on the current drop. */
    const restartAttempts = useRef(0);
    /**
     * Successful restarts since the last heartbeat: when ICE is up but the
     * path stays quiet, enough of these in a row means the session itself is
     * wedged and only a reopen heals it.
     */
    const restartCycles = useRef(0);
    /** The last ICE state the peer or the engine reported. */
    const iceConnected = useRef(false);
    /** The engine's restore token, for a consent-free reopen. Unset by hand. */
    const restoreToken = useRef<string | null>(null);
    /** The latest status and presentation, read by event handlers. */
    const statusRef = useRef<SessionSnapshot['status']>('idle');
    const presentedRef = useRef(false);
    /** The latest snapshot; mirrored eagerly so timers read exact state. */
    const snapshotRef = useRef<SessionSnapshot>(IDLE);
    const diagnostics = useRef<Record<string, string | number | boolean>>({});
    /** When the app left the foreground, or null while it is active. */
    const awaySince = useRef<number | null>(null);
    /** Guards every asynchronous callback against a session that already ended. */
    const generationToken = useRef(0);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const update = useCallback((patch: Partial<SessionSnapshot>) => {
        // Mirrored eagerly: timers read these between renders, and React may
        // defer the render itself. (Calling onStateChange here also keeps it
        // to one call per update, where the updater form could double-fire.)
        const next = { ...snapshotRef.current, ...patch };
        snapshotRef.current = next;
        statusRef.current = next.status;
        presentedRef.current = next.presented;
        setSnapshot(next);
        optionsRef.current.onStateChange?.(next);
    }, []);

    const fail = useCallback((failure: SessionFailure) => {
        update({ status: 'failed', failure });
        optionsRef.current.onError?.(failure);
    }, [update]);

    const refuse = useCallback((message: string, code: SessionFailure['code'] = 'platform') => {
        fail({ code, message });
    }, [fail]);

    /** A transport loss is one event no matter how many sides report it: the
     * peer's `failed` state and its `failure` event would otherwise spend the
     * reopen budget twice for the same outage. */
    const transportFailed = useCallback((message: string = UNREACHABLE_DESKTOP) => {
        if (statusRef.current === 'failed') return;
        refuse(message, 'transport');
    }, [refuse]);

    const cancelRestart = useCallback(() => {
        if (restartTimer.current !== null) clearTimeout(restartTimer.current);
        restartTimer.current = null;
    }, []);

    const cancelReconnect = useCallback(() => {
        if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
    }, []);

    const cancelStall = useCallback(() => {
        if (stallTimer.current !== null) clearTimeout(stallTimer.current);
        stallTimer.current = null;
    }, []);

    const scheduleRestartRef = useRef<(delay: number) => void>(() => undefined);

    /**
     * Spend one restart from the backoff schedule, or reopen when the schedule
     * is spent: a peer may never report `failed` (a resumed phone often does
     * not), and waiting for it would leave the session reconnecting forever.
     */
    const spendRestartAttempt = useCallback((): void => {
        if (statusRef.current !== 'reconnecting' || nativeRef.current == null) return;
        const wait = backoffDelay(RESTART_BACKOFF_MS, restartAttempts.current);
        if (wait === null) {
            transportFailed('the desktop did not come back; reopening the session');
            return;
        }
        restartAttempts.current += 1;
        scheduleRestartRef.current(wait);
    }, [transportFailed]);

    /**
     * Queue the next ICE restart after `delay`, or do nothing when an attempt
     * is already queued or the session is gone. The status is validated when
     * the timer fires rather than here: the caller just moved the session to
     * `reconnecting` and that update has not been processed yet.
     *
     * A restart asks the engine to re-offer on the same peer connection; the
     * offer arrives as the usual description event and is answered as usual.
     * The session never reopens for it.
     */
    const scheduleRestart = useCallback((delay: number) => {
        if (restartTimer.current !== null) return;
        if (nativeRef.current == null) return;
        restartTimer.current = setTimeout(() => {
            restartTimer.current = null;
            if (statusRef.current !== 'reconnecting') return;
            const openedRef = opened.current;
            const channel = signaling.current;
            if (openedRef == null || channel == null) {
                spendRestartAttempt();
                return;
            }
            void (async () => {
                try {
                    await channel.request('session.restart_ice', {
                        session_id: openedRef.sessionId,
                        generation: openedRef.generation,
                    });
                } catch {
                    spendRestartAttempt();
                    return;
                }
                if (statusRef.current !== 'reconnecting') return;
                restartGraceUntil.current = Date.now() + RESTART_GRACE_MS;
                restartCycles.current += 1;
                // Media is up but the path stays quiet after clean restarts:
                // the session itself is wedged and only a reopen heals it.
                // (While ICE is down, patience: the network may still come
                // back, and the backoff schedule owns that case.)
                if (restartCycles.current >= 2 && iceConnected.current) {
                    transportFailed('the desktop stopped responding; reopening the session');
                    return;
                }
                // The engine re-offers through the usual description event,
                // which the session answers as usual; without recovery by the
                // reply deadline, spend the next attempt. A live transport
                // answers in milliseconds, so hold it to a short leash.
                const replyMs = iceConnected.current ? 2000 : RESTART_REPLY_MS;
                restartTimer.current = setTimeout(() => {
                    restartTimer.current = null;
                    spendRestartAttempt();
                }, replyMs);
            })();
        }, delay);
    }, [spendRestartAttempt, transportFailed]);

    useEffect(() => {
        scheduleRestartRef.current = scheduleRestart;
        checkStallRef.current = checkStall;
    });

    const checkStallRef = useRef(() => {});

    /**
     * One ICE or engine-transport state, from either reporter. The mapping is
     * idempotent, so the peer's event and the engine's `session.state` telling
     * the same story neither double-counts nor fights.
     */
    const onTransportState = useCallback((state: string, trackIce = true) => {
        // Synthetic stall reports say nothing about ICE itself.
        if (trackIce) iceConnected.current = state === 'connected' || state === 'completed';
        const next = connectionStatusFor(state, statusRef.current, presentedRef.current);
        if (next === null) return;
        // Our own restart's transients are expected, not a new outage.
        if (next === 'reconnecting' && Date.now() < restartGraceUntil.current) return;
        update({ status: next });
        if (next === 'reconnecting') {
            // Only a path that once carried frames is worth restarting: an
            // initial connection that never got there has nothing to save.
            if (presentedRef.current) {
                restartAttempts.current = 0;
                scheduleRestart(RESTART_AFTER_MS);
            }
        } else {
            cancelRestart();
            if (next === 'live') {
                // The path is back but may be quiet: a missing heartbeat
                // from here is a stalled session, not a healthy idle one.
                cancelStall();
                stallTimer.current = setTimeout(() => checkStallRef.current(), STALL_AFTER_MS);
            }
        }
    }, [cancelRestart, cancelStall, scheduleRestart, update]);

    /**
     * One stall check: quiet too long while the session should be talking
     * means the path is stalled, even when ICE has not said so yet. Only
     * refs and module constants, so stable callbacks may hold it.
     */
    const checkStall = useCallback((): void => {
        stallTimer.current = null;
        if (lastPingAt.current === 0) return;
        // A timer that fires a shade early re-arms for the remainder rather
        // than dying: a one-shot watchdog must not miss by milliseconds.
        const quietMs = Date.now() - lastPingAt.current;
        if (quietMs < STALL_AFTER_MS) {
            stallTimer.current = setTimeout(() => checkStallRef.current(), STALL_AFTER_MS - quietMs);
            return;
        }
        const status = statusRef.current;
        if (status !== 'live' && status !== 'connecting' && status !== 'reconnecting') return;
        if (Date.now() < restartGraceUntil.current) {
            // Our own restart's transients: recheck when the grace ends.
            stallTimer.current = setTimeout(() => checkStallRef.current(), restartGraceUntil.current - Date.now());
            return;
        }
        onTransportState('disconnected', false);
    }, [onTransportState]);

    /**
     * One engine heartbeat: the path works. It clears a stall the watchdog
     * saw, then rearms the watchdog — which stays disarmed on engines that
     * predate heartbeats, since `lastPingAt` never leaves 0 for them.
     */
    const notePing = useCallback(() => {
        lastPingAt.current = Date.now();
        restartCycles.current = 0;
        cancelStall();
        // A heartbeat is the engine alive and the path working.
        if (statusRef.current === 'reconnecting') onTransportState('connected');
        stallTimer.current = setTimeout(checkStall, STALL_AFTER_MS);
    }, [cancelStall, checkStall, onTransportState]);

    const send = useCallback((message: ControlMessage) => {
        const id = nativeRef.current;
        if (id == null || nativeDesklink === null || (!inputEnabled.current && message.kind !== 'release_all')) return;
        nativeDesklink.sendControl(id, JSON.stringify(message));
    }, []);

    const setInputEnabled = useCallback((enabled: boolean) => {
        inputEnabled.current = enabled;
        const id = nativeRef.current;
        if (!enabled && modifiersRef.current !== NO_MODIFIERS) {
            modifiersRef.current = NO_MODIFIERS;
            setModifiers(NO_MODIFIERS);
            if (id != null) nativeDesklink?.captureKeyboard(id, false);
        }
        if (id != null) nativeDesklink?.setInputEnabled(id, enabled);
    }, []);

    const releaseHeld = useCallback(() => {
        send({ kind: 'release_all' });
    }, [send]);

    const applyModifiers = useCallback((next: StickyModifiers) => {
        const current = modifiersRef.current;
        if (next.Control === current.Control && next.Shift === current.Shift && next.Alt === current.Alt && next.Meta === current.Meta) return;
        modifiersRef.current = next;
        setModifiers(next);
        // The phone's keyboard is the session's own only while a modifier waits
        // for its key; otherwise typing goes straight to the desktop.
        const id = nativeRef.current;
        if (id != null) nativeDesklink?.captureKeyboard(id, armedModifiers(next).length > 0);
    }, []);

    const tapModifier = useCallback((name: StickyModifier) => {
        applyModifiers(nextModifiers(modifiersRef.current, name));
    }, [applyModifiers]);

    const pressKey = useCallback((name: string) => {
        const held = armedModifiers(modifiersRef.current);
        send({ kind: 'key', name, modifiers: held, down: true });
        applyModifiers(afterKey(modifiersRef.current));
        let pressed = true;
        return () => {
            if (!pressed) return;
            pressed = false;
            send({ kind: 'key', name, modifiers: held, down: false });
        };
    }, [send, applyModifiers]);

    const typeText = useCallback((text: string) => {
        const { messages, next } = typeWithModifiers(text, modifiersRef.current);
        for (const message of messages) send(message);
        applyModifiers(next);
    }, [send, applyModifiers]);

    const showKeyboard = useCallback(() => {
        const id = nativeRef.current;
        if (id != null) nativeDesklink?.showKeyboard(id);
    }, []);

    const hideKeyboard = useCallback(() => {
        const id = nativeRef.current;
        if (id != null) nativeDesklink?.hideKeyboard(id);
    }, []);

    const fitToView = useCallback(() => {
        const id = nativeRef.current;
        if (id != null) nativeDesklink?.fitToView(id);
    }, []);

    const setOrientation = useCallback((mode: 'landscape' | 'auto') => {
        nativeDesklink?.setOrientation(mode);
    }, []);

    /** Drop everything this process holds for a session the engine has ended. */
    const discardSession = useCallback(() => {
        generationToken.current += 1;
        const id = nativeRef.current;
        nativeRef.current = null;
        inputEnabled.current = false;
        for (const resolve of pendingClipboard.current.values()) resolve({ text: '', truncated: false, error: 'the session ended' });
        pendingClipboard.current.clear();
        pendingOffer.current = null;
        pendingCandidates.current = [];
        restartGraceUntil.current = 0;
        restartCycles.current = 0;
        opened.current = null;
        signaling.current = null;
        setNativeId(null);
        // An armed modifier belongs to the session it was armed in.
        modifiersRef.current = NO_MODIFIERS;
        setModifiers(NO_MODIFIERS);
        if (id != null) nativeDesklink?.closeSession(id);
    }, []);

    /** Tell the host a session is over; a failure is nothing the user can act on. */
    const endRemote = useCallback(async (
        openedRef: SessionOpenResult | null,
        owner: Signaling | null,
    ): Promise<void> => {
        if (openedRef == null || owner == null) return;
        try {
            await owner.request('session.close', {
                session_id: openedRef.sessionId,
                generation: openedRef.generation,
            });
        } catch {
            // The engine already dropped it; nothing useful to report.
        }
    }, []);

    const teardown = useCallback(async (reason: string, closeRemote: boolean) => {
        cancelReconnect();
        cancelRestart();
        cancelStall();
        restoreToken.current = null;
        const openedRef = opened.current;
        const owner = signaling.current;
        discardSession();
        if (closeRemote) await endRemote(openedRef, owner);
        update({ status: 'ended', presented: false, failure: null });
        void reason;
    }, [cancelReconnect, cancelRestart, cancelStall, endRemote, discardSession, update]);

    const establish = useCallback(async () => {
        if (nativeRef.current != null) return;
        const token = ++generationToken.current;
        if (!(await loadPlatform())) {
            if (token === generationToken.current) refuse('this build cannot show a desktop surface');
            return;
        }
        if (token !== generationToken.current) return;
        update({ status: 'opening', failure: null, presented: false });

        let authorization: { signaling: Signaling; session: SessionOpenRequest };
        try {
            authorization = await optionsRef.current.authorize();
        } catch (error) {
            refuse(error instanceof Error ? error.message : 'the desktop was not authorized', 'permission');
            return;
        }
        if (token !== generationToken.current) return;
        signaling.current = authorization.signaling;

        // Subscribed before the open, because the engine's offer and its first
        // candidates can beat the open result back. Anything that arrives
        // before the native session exists is stashed and replayed into it.
        authorization.signaling.subscribe((event) => {
            if (token !== generationToken.current) return;
            const native = nativeRef.current;
            const held = opened.current;
            const current = event.sessionId === undefined || held == null || held.sessionId === event.sessionId;
            switch (event.kind) {
                case 'description':
                    if (event.description.type !== 'offer') return;
                    if (native == null || held == null) {
                        pendingOffer.current = { sdp: event.description.sdp, sessionId: event.sessionId };
                        return;
                    }
                    if (!current) return;
                    // A mid-session re-offer is a restart this session asked
                    // for, through its policy or directly: renegotiation
                    // transients after it are expected, not a new outage.
                    if (presentedRef.current) restartGraceUntil.current = Date.now() + RESTART_GRACE_MS;
                    nativeDesklink?.setRemoteDescription(native, 'offer', event.description.sdp);
                    return;
                case 'candidate':
                    if (native == null || held == null) {
                        pendingCandidates.current.push({
                            candidate: event.candidate.candidate,
                            sdpMid: event.candidate.sdpMid ?? null,
                            sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
                            sessionId: event.sessionId,
                        });
                        return;
                    }
                    if (!current) return;
                    nativeDesklink?.addRemoteCandidate(
                        native,
                        event.candidate.candidate,
                        event.candidate.sdpMid ?? null,
                        event.candidate.sdpMLineIndex ?? null,
                    );
                    return;
                case 'state':
                    if (!current) return;
                    diagnostics.current.transport = event.transport;
                    // Before the session exists there is nothing to map onto.
                    if (held != null) onTransportState(String(event.transport ?? '').toLowerCase());
                    update({ diagnostics: { ...diagnostics.current } });
                    return;
                case 'restoreToken':
                    // The live session's grant for a consent-free reopen.
                    if (current && held != null) restoreToken.current = event.token;
                    return;
                case 'revoked':
                    // Nothing held: the reopen policy owns recovery, and a
                    // dead session's late revocation must not end it.
                    if (held == null || !current) return;
                    // A lost path is an outage, not a verdict: the reopen
                    // policy asks for fresh authority. Any other code, or
                    // none, is the session's authority ending.
                    if (event.code === 'transport') {
                        transportFailed(event.reason);
                        return;
                    }
                    void teardown(event.reason, false);
                    update({ status: 'ended', failure: { code: 'revoked', message: event.reason } });
                    return;
                default:
                    return;
            }
        });

        let openedResult: SessionOpenResult;
        try {
            openedResult = await authorization.signaling.request<SessionOpenResult>('session.open', {
                permissions: authorization.session.permissions,
                max_width: authorization.session.maxWidth,
                max_height: authorization.session.maxHeight,
                bitrate_kbps: authorization.session.bitrateKbps,
                max_fps: authorization.session.maxFps,
                ice_servers: serializeIceServers(authorization.session.iceServers),
                // A restore token the live session earned buys a consent-free
                // reopen; the app's own grant wins when it names one.
                restore_token: authorization.session.restoreToken ?? restoreToken.current ?? undefined,
                ttl_seconds: authorization.session.ttlSeconds,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'the desktop could not start';
            refuse(message, classifyOpenFailure(error));
            return;
        }
        let established = false;
        try {
            if (token !== generationToken.current) return;
            opened.current = openedResult;
            update({ geometry: openedResult.geometry, status: 'connecting' });
            if (token !== generationToken.current) return;

            const platform = nativeDesklink;
            const id = platform === null ? null : platform.createSession(
                JSON.stringify(authorization.session.iceServers ?? []),
            );
            if (id == null) {
                refuse('the native session could not be created');
                return;
            }
            if (token !== generationToken.current) {
                platform?.closeSession(id);
                return;
            }
            nativeRef.current = id;
            platform?.setInputEnabled(id, inputEnabled.current);
            setNativeId(id);

            // Anything the engine sent before the native session existed.
            // A stashed message naming another session is a previous
            // generation's leftover and is dropped, not replayed.
            const stashedOffer = pendingOffer.current;
            pendingOffer.current = null;
            if (stashedOffer !== null
                && (stashedOffer.sessionId === undefined || stashedOffer.sessionId === openedResult.sessionId)) {
                platform?.setRemoteDescription(id, 'offer', stashedOffer.sdp);
            }
            for (const candidate of pendingCandidates.current.splice(0)) {
                if (candidate.sessionId !== undefined && candidate.sessionId !== openedResult.sessionId) continue;
                platform?.addRemoteCandidate(id, candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex);
            }

            if (token === generationToken.current) established = true;
        } catch (error) {
            if (token === generationToken.current) {
                refuse(error instanceof Error ? error.message : 'the native session could not be created');
            }
        } finally {
            if (!established) {
                if (opened.current === openedResult) discardSession();
                await endRemote(openedResult, authorization.signaling);
            }
        }
    }, [discardSession, endRemote, refuse, teardown, transportFailed, update, onTransportState]);

    /**
     * Open (or reopen) the session with fresh authority. A deliberate call
     * starts a fresh reopen budget; the automatic retry calls `establish`
     * directly so its budget survives.
     */
    const connect = useCallback(async () => {
        attempts.current = 0;
        restartAttempts.current = 0;
        restartCycles.current = 0;
        cancelRestart();
        await establish();
    }, [cancelRestart, establish]);

    // Native events: answer, candidates, control replies, presentation, failure.
    useEffect(() => {
        let dropped = false;
        let subscription: { remove: () => void } | null = null;
        const subscribe = async (): Promise<void> => {
            // The platform module is loaded on first use, which may be after this
            // effect runs; subscribing before it resolves would drop the listener.
            if (!(await loadPlatform())) return;
            if (dropped) return;
            const platform = nativeDesklink;
            if (platform?.addListener == null) return;
            subscription = platform.addListener('onSessionEvent', (event) => {
                if (dropped) return;
                if (event.sessionId !== nativeRef.current) return;
                const openedRef = opened.current;
                const channel = signaling.current;
                switch (event.name) {
                    case 'answer': {
                        const sdp = String(event.payload.sdp ?? '');
                        if (openedRef == null || channel == null || sdp === '') return;
                        channel.request('session.description', {
                            session_id: openedRef.sessionId,
                            generation: openedRef.generation,
                            description: { type: 'answer', sdp },
                        }).catch(() => refuse('the desktop refused our answer', 'transport'));
                        return;
                    }
                    case 'candidate': {
                        if (openedRef == null || channel == null) return;
                        channel.request('session.candidate', {
                            session_id: openedRef.sessionId,
                            generation: openedRef.generation,
                            candidate: String(event.payload.candidate ?? ''),
                            sdpMid: (event.payload.sdpMid as string | null) ?? null,
                            sdpMLineIndex: (event.payload.sdpMLineIndex as number | null) ?? null,
                        }).catch(() => undefined);
                        return;
                    }
                    case 'track':
                        // Readiness is not "a track arrived": it is a frame on screen.
                        return;
                    case 'presented':
                        attempts.current = 0;
                        restartAttempts.current = 0;
                        restartCycles.current = 0;
                        cancelRestart();
                        update({ status: 'live', presented: true, failure: null });
                        return;
                    case 'control': {
                        const reply = parseControlReply(String(event.payload.message ?? ''));
                        if (reply == null) return;
                        if (reply.kind === 'ping') {
                            notePing();
                            return;
                        }
                        if (reply.kind === 'hello') {
                            diagnostics.current.protocol = reply.protocol;
                            if (reply.protocol !== PROTOCOL_VERSION) {
                                refuse('this app and the host engine speak different protocol versions', 'incompatible-version');
                                void teardown('protocol mismatch', true);
                                return;
                            }
                            update({ geometry: reply.geometry });
                            // The native view needs the surface size to map touches.
                            const id = nativeRef.current;
                            if (id != null) {
                                nativeDesklink?.setSurfaceSize(id, reply.geometry.encoded.width, reply.geometry.encoded.height);
                            }
                            return;
                        }
                        if (reply.kind === 'clipboard') {
                            pendingClipboard.current.get(reply.request)?.({ text: reply.text, truncated: reply.truncated === true, error: reply.error });
                            pendingClipboard.current.delete(reply.request);
                            return;
                        }
                        if (reply.kind === 'rejected') {
                            diagnostics.current.lastRejection = `${reply.code}: ${reply.message}`;
                            update({ diagnostics: { ...diagnostics.current } });
                            optionsRef.current.onRejected?.({ code: reply.code, message: reply.message });
                            return;
                        }
                        if (reply.kind === 'revoked') {
                            // The engine ends the data channel with a revocation when
                            // the session is replaced or closed; it is the only notice
                            // the client gets, so it has to end the session here —
                            // unless the path was lost, which a reopen heals.
                            if (reply.code === 'transport') {
                                transportFailed(reply.reason);
                                return;
                            }
                            void teardown(reply.reason, false);
                            update({ status: 'ended', failure: { code: 'revoked', message: reply.reason } });
                            return;
                        }
                        return;
                    }
                    case 'ice': {
                        // The peer's connection state, as it happens: Android
                        // and iOS already emit this, and web matches them.
                        const state = String(event.payload.state ?? '').toLowerCase();
                        if (state === 'failed') transportFailed();
                        else onTransportState(state);
                        return;
                    }
                    case 'keyboard':
                        // Typing the platform held back for an armed modifier.
                        if (typeof event.payload.key === 'string') pressKey(event.payload.key)();
                        else if (typeof event.payload.text === 'string') typeText(event.payload.text);
                        return;
                    case 'failure':
                        transportFailed();
                        return;
                    case 'closed':
                        return;
                    default:
                        return;
                }
            });
        };
        void subscribe();
        return () => {
            dropped = true;
            subscription?.remove();
        };
    }, [transportFailed, onTransportState, cancelRestart, spendRestartAttempt, notePing, teardown, update, pressKey, typeText]);

    const copyRemoteToLocal = useCallback(async () => {
        if (!inputEnabled.current) throw new Error('Desktop control is off.');
        const id = nativeRef.current;
        if (id == null || nativeDesklink == null) throw new Error('No desktop session is open.');
        const request = randomId();
        const answer = new Promise<{ text: string; truncated: boolean; error?: string }>((resolve) => {
            pendingClipboard.current.set(request, resolve);
            setTimeout(() => {
                if (pendingClipboard.current.delete(request)) resolve({ text: '', truncated: false, error: 'the desktop did not answer' });
            }, CLIPBOARD_TIMEOUT_MS);
        });
        nativeDesklink.sendControl(id, JSON.stringify({ kind: 'clipboard_read', request }));
        const reply = await answer;
        if (reply.error != null) throw new Error(reply.error);
        return { text: reply.text, truncated: reply.truncated };
    }, []);

    const pasteLocalToRemote = useCallback(async (text: string) => {
        if (!inputEnabled.current) throw new Error('Desktop control is off.');
        const id = nativeRef.current;
        if (id == null || nativeDesklink == null) throw new Error('No desktop session is open.');
        const request = randomId();
        const answer = new Promise<{ text: string; truncated: boolean; error?: string }>((resolve) => {
            pendingClipboard.current.set(request, resolve);
            setTimeout(() => {
                if (pendingClipboard.current.delete(request)) resolve({ text: '', truncated: false, error: 'the desktop did not answer' });
            }, CLIPBOARD_TIMEOUT_MS);
        });
        nativeDesklink.sendControl(id, JSON.stringify({ kind: 'clipboard_write', request, text }));
        const reply = await answer;
        if (reply.error != null) throw new Error(reply.error);
    }, []);

    const close = useCallback(async (reason = 'closed by the user') => {
        cancelReconnect();
        attempts.current = 0;
        restartAttempts.current = 0;
        restartCycles.current = 0;
        await teardown(reason, true);
    }, [cancelReconnect, teardown]);

    // Reopen with fresh authority after a transport failure, backing off
    // across about a minute: a session that was revoked must not be reopened
    // on the strength of the old grant, and an outage that outlasts one
    // attempt must not spend the whole budget while the network is still down.
    useEffect(() => {
        if (snapshot.status !== 'failed') return;
        if (snapshot.failure?.code !== 'transport') return;
        // The failed session is dead on the engine side. Drop its handle and
        // close the remote session whether or not another attempt is left: a
        // failure the user can retry by hand must not sit behind a stale
        // native handle that makes `connect()` a no-op.
        const owner = signaling.current;
        const openedRef = opened.current;
        cancelRestart();
        discardSession();
        void endRemote(openedRef, owner);
        const wait = backoffDelay(REOPEN_BACKOFF_MS, attempts.current);
        if (wait === null) return;
        attempts.current += 1;
        update({ status: 'reconnecting' });
        reconnectTimer.current = setTimeout(() => {
            reconnectTimer.current = null;
            void establish();
        }, wait);
    }, [establish, cancelRestart, discardSession, endRemote, snapshot.status, snapshot.failure, update]);

    useEffect(() => () => {
        cancelReconnect();
        cancelRestart();
        cancelStall();
        generationToken.current += 1;
        const id = nativeRef.current;
        nativeRef.current = null;
        inputEnabled.current = false;
        if (id != null) nativeDesklink?.closeSession(id);
        const openedRef = opened.current;
        const owner = signaling.current;
        opened.current = null;
        signaling.current = null;
        void endRemote(openedRef, owner);
    }, [cancelReconnect, endRemote]);

    // A phone that goes to the background must not leave a remote button held:
    // the desktop cannot know the finger left the glass. This is the same
    // release path a lost control channel takes.
    //
    // Coming back, a session that was away long enough for the path to lapse
    // reopens without spending restarts on it, once anything queued has had
    // a moment to arrive; one already waiting to reopen stops waiting: the
    // app was suspended, so no timer or peer event can be trusted to have run.
    useEffect(() => {
        let resumeTimer: ReturnType<typeof setTimeout> | null = null;
        const subscription = AppState.addEventListener('change', (status) => {
            if (status !== 'active') {
                // `inactive` is Control Centre or the app switcher: the app
                // still runs, so only `background` starts the clock.
                if (status === 'background') awaySince.current ??= Date.now();
                releaseHeld();
                return;
            }
            const away = awaySince.current === null ? 0 : Date.now() - awaySince.current;
            awaySince.current = null;
            const current = statusRef.current;
            const waiting = (current === 'reconnecting' && nativeRef.current == null)
                || (current === 'failed' && snapshotRef.current.failure?.code === 'transport');
            if (waiting) {
                cancelReconnect();
                void connect();
                return;
            }
            const id = nativeRef.current;
            if (away < BACKGROUND_REOPEN_MS || id == null) return;
            // ponytail: a fixed drain window; a revocation queued behind it
            // is dropped with the old session, as any reopen drops one.
            if (resumeTimer !== null) clearTimeout(resumeTimer);
            resumeTimer = setTimeout(() => {
                resumeTimer = null;
                const now = statusRef.current;
                if (nativeRef.current !== id) return;
                if (now !== 'live' && now !== 'connecting' && now !== 'reconnecting') return;
                attempts.current = 0;
                transportFailed('the app was in the background; reopening the session');
            }, RESUME_DRAIN_MS);
        });
        return () => {
            if (resumeTimer !== null) clearTimeout(resumeTimer);
            subscription.remove();
        };
    }, [releaseHeld, cancelReconnect, connect, transportFailed]);

    return useMemo<DesktopSession>(() => ({
        snapshot,
        nativeId,
        connect,
        close,
        showKeyboard,
        hideKeyboard,
        copyRemoteToLocal,
        pasteLocalToRemote,
        releaseHeld,
        setInputEnabled,
        fitToView,
        setOrientation,
        send,
        modifiers,
        tapModifier,
        pressKey,
    }), [
        snapshot,
        nativeId,
        connect,
        close,
        showKeyboard,
        hideKeyboard,
        copyRemoteToLocal,
        pasteLocalToRemote,
        releaseHeld,
        setInputEnabled,
        fitToView,
        setOrientation,
        send,
        modifiers,
        tapModifier,
        pressKey,
    ]);
}

function serializeIceServers(servers: IceServerConfig[] | undefined): Array<Record<string, unknown>> {
    return (servers ?? []).map((server) => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential,
    }));
}

function randomId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The permissions a normal remote-control session asks for. */
export const CONTROL_PERMISSIONS: Permission[] = ['view', 'control', 'clipboard'];
