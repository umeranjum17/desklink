/**
 * The engine's local control protocol, as a consumer sees it.
 *
 * `docs/PROTOCOL.md` is the prose authority; these types are the same contract
 * expressed for a caller. They deliberately contain nothing about any particular
 * application: a machine id, a chat or an account has no place here.
 */

export const PROTOCOL_VERSION = 3;

export interface EngineError {
    code: string;
    message: string;
}

export interface EngineCapabilities {
    protocol: number;
    engine: string;
    platform: string;
    session: { kind: string; on_console?: boolean };
    /** Whether the X11 backend can reach a server here, and that server's screen size. */
    x11: { available: boolean; size: [number, number] | null };
    capture: {
        mechanism: string;
        /** Backends this build has, not what this machine can necessarily use. */
        backends: string[];
        formats: string[];
        cursor: string;
        audio: boolean;
        displays?: Array<{
            id: number;
            width: number;
            height: number;
            scale: number;
            points: { width: number; height: number };
            origin: { x: number; y: number };
            main: boolean;
        }>;
        grant?: string;
        unavailable_reason?: { reason: string; remedy: string } | null;
    };
    encode: { codecs: string[]; hardware: boolean };
    input: {
        mechanism: string;
        pointer: boolean;
        wheel: boolean;
        keyboard: boolean;
        text: string[];
        layout: string;
        unavailable_reason: { reason: string; remedy: string } | null;
        grant: string;
    };
    clipboard: { read: boolean; write: boolean; mime: string[]; maxBytes: number };
}

export interface SurfaceGeometry {
    source: { width: number; height: number };
    encoded: { width: number; height: number };
    origin: { x: number; y: number };
}

/**
 * Which desktop to capture. Absent means the platform default; macOS can target
 * a specific display while Linux uses the portal or an explicit X display.
 */
export type SourceRequest =
    | { kind: 'portal' }
    | { kind: 'display'; display_id?: number }
    | { kind: 'x11'; display?: string };

export interface OpenSessionRequest {
    source?: SourceRequest;
    /** `view` alone is capture-only; `control` needs a working input backend. */
    permissions: Array<'view' | 'control' | 'clipboard'>;
    maxWidth?: number;
    maxHeight?: number;
    bitrateKbps?: number;
    maxFps?: number;
    iceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
    restoreToken?: string;
    ttlSeconds?: number;
    /** Also listen for ICE over TCP on the loopback, for a client behind a local forward. */
    loopbackTcp?: boolean;
    /** Local cursor feedback for an agent session; off for human phone control. */
    agentIndicator?: boolean;
}

export interface OpenedSession {
    sessionId: string;
    generation: number;
    source: {
        kind: string;
        width: number;
        height: number;
        origin: { x: number; y: number };
    };
    geometry: SurfaceGeometry;
}

export type EngineEvent =
    | { event: 'session.description'; params: { sessionId: string; generation: number; description: { type: 'offer'; sdp: string } } }
    | {
          event: 'session.candidate';
          params: {
              sessionId: string;
              generation: number;
              candidate: string;
              sdpMid: string | null;
              sdpMLineIndex: number | null;
          };
      }
    | { event: 'session.frame.changed'; params: { sessionId: string; seq: number; damage: number[][] } }
    | { event: 'session.state'; params: { sessionId: string; capture: string; transport: string; firstFrame: boolean } }
    | { event: 'session.restoreToken'; params: { sessionId: string; token: string } }
    | { event: 'session.capture.stopped'; params: { sessionId: string; reason: string } }
    | { event: 'session.revoked'; params: { sessionId: string; reason: string } };

export type EngineEventName = EngineEvent['event'];

export interface SessionMetrics {
    captured_frames: number;
    dropped_frames: number;
    encoded_frames: number;
    encoded_bytes: number;
    input_applied: number;
    input_rejected: number;
}

/** A protocol-level failure carrying the engine's stable error code. */
export class EngineRefused extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'EngineRefused';
        this.code = code;
    }
}
