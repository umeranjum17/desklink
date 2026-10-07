import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';

// The userspace-shaped link the drop-and-recover journeys run on: a datagram
// relay between a browser's ICE agent and the engine's, which decides per
// datagram to forward it now, forward it after a delay, or discard it.
//
// It is NOT kernel netem, NOT `tc`, NOT an iptables or nftables rule, and it
// needs no sudo, no root, no firewall rule and no change to the host firewall.
// Every shape a run reports was produced by this module dropping or delaying
// its own datagrams, and `counters` is the record of what it did. Say
// "userspace-shaped link" in every report about it; never "netem".
/**
 * One candidate line, as the fields this relay needs.
 *
 * `candidate:<foundation> <component> <proto> <priority> <ip> <port> typ <type>`
 * — everything after `typ` is carried through untouched, so an extension this
 * flow has never heard of cannot cost the candidate.
 */
function parseCandidate(line) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 8 || !parts[0].startsWith('candidate:') || parts[6] !== 'typ') return null;
    const port = Number(parts[5]);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return { foundation: parts[0], component: parts[1], proto: parts[2], priority: parts[3], ip: parts[4], port, type: parts[7], rest: parts.slice(8) };
}

const renderCandidate = (candidate, ip, port) =>
    [candidate.foundation, candidate.component, candidate.proto, candidate.priority, ip, String(port), 'typ', candidate.type, ...candidate.rest].join(' ');

/**
 * RTP or RTCP, which is the picture and nothing else.
 *
 * The first byte carries the version in its top two bits: 10 for RTP and RTCP,
 * and every datagram this relay forwards is either STUN (a leading 0x00–0x03),
 * DTLS (0x14–0x19) or RTP/RTCP. SRTP is encrypted, but the header stays in the
 * clear by design, so this reads the same before and after encryption.
 */
function isMedia(payload) {
    if (payload.length === 0) return false;
    return (payload[0] & 0xc0) === 0x80;
}

/** Loopback and every local IPv4 address, so a candidate can be checked before it is trusted. */
function localAddresses() {
    const found = new Set(['127.0.0.1']);
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) found.add(entry.address);
        }
    }
    return found;
}

/**
 * The userspace link: a datagram relay this process owns, in the middle of the
 * browser's ICE agent and the engine's.
 *
 * It touches no kernel traffic control, no firewall and no privileged path. It
 * holds the sockets, so it decides per datagram and per direction whether the
 * datagram is forwarded now, forwarded after `delayMs`, or discarded. That is
 * the whole of the shaping, and `counters` is the record of what it did.
 *
 * Two sockets, and why each one can only ever carry one direction is worth
 * writing down, because the obvious design is wrong in a way that only shows up
 * after a drop. An advertised address is where its peer sends, and the far end
 * then treats whatever comes back from that address as that peer's answer. So a
 * socket that both receives from one peer and sends to it, out of itself, will
 * eventually receive that peer's own packets and have no way to tell them from
 * the other peer's. Before a cut the session is already established and the
 * mistake costs nothing; after a cut it bounces the browser's traffic back to
 * the browser and the recovery can never complete.
 *
 * So each direction has a socket of its own and every datagram leaves from the
 * *other* one:
 *
 *   `toEngine` — advertised to the BROWSER as the engine's candidate. Only the
 *                browser ever learns this address, so only the browser's packets
 *                arrive here. They go to the engine, out of `toBrowser`.
 *   `toBrowser` — advertised to the ENGINE as the browser's candidate. Only the
 *                engine ever learns this address, so only the engine's packets
 *                arrive here — both its own checks and its replies to what this
 *                relay forwarded for it. They go to the browser, out of
 *                `toEngine`.
 *
 * Nothing is told which of the two belongs to it, so nothing can be answered
 * on the wrong socket and no direction has to be guessed from a source address.
 *
 * Both peers' real addresses are read at send time, never captured when a
 * socket was made: an ICE restart makes the engine rebind, and a relay that
 * remembered the old port would forward into nothing after a recovery, failing
 * this proof for a reason that has nothing to do with the client.
 */
class ShapedLink {
    /** The socket each direction is sent from, and the ports they are advertised on. */
    #routes = new Map();
    /** Candidates are taken one at a time, in arrival order. */
    #queue = Promise.resolve();

    constructor(log) {
        this.log = log;
        this.counters = { toEngine: 0, toBrowser: 0, delayed: 0, discarded: 0, unroutable: 0, mediaDiscarded: 0 };
        /** `{}` forwards at once, `{ delayMs }` slows it, `{ discard: true }` drops it. */
        this.shape = {};
        /**
         * Drop media and nothing else. The peers bundle their video and their
         * data channel onto one 5-tuple and every datagram on it is small, so
         * size cannot tell a frame from a heartbeat. What does tell them apart
         * is the first byte: STUN and DTLS — consent checks and the control
         * channel — lead with 0x00–0x03 or 0x14–0x19, while RTP and RTCP lead
         * with 0x80–0xBF. Dropping only those is a media cut with signalling,
         * ICE and control still up, which is the case a client cannot see the
         * loss of by listening to the transport.
         */
        this.discardMedia = false;
        /** The engine candidate the relay forwards to, per generation. */
        this.host = null;
        /** Where the browser really is, learned from the packets it sends. */
        this.browser = null;
        this.sockets = new Set();
        /** Every shape change, with the counters it started from. */
        this.marks = [];
        /** Delayed sends still waiting for their delay when the run ends. */
        this.timers = new Set();
        this.local = localAddresses();
    }

    /** A one-line account of what the link is doing, for a run that stalls. */
    report(why) {
        this.log(`link ${why}: ${JSON.stringify(this.counters)}; host ${this.host?.ip ?? '-'}:${this.host?.port ?? '-'} browser ${this.browser?.ip ?? '-'}:${this.browser?.port ?? '-'}`);
    }

    /**
     * A new `session.open` from the client.
     *
     * A session is the unit the engine commits its peers within, so this is
     * where the one-candidate-per-session counters go back to their start. The
     * engine's own candidate is not reset: an ICE restart inside a session is
     * not a new session, and the relay must keep following the same socket.
     */
    newSession() {
        // Signalling assigns a fresh ICE generation to the next offer.
    }

    /** Adopt a shape and record when it happened, so the receipt shows the order. */
    set(shape, why) {
        this.marks.push({ at: Date.now(), why, shape: { ...shape }, countersBefore: { ...this.counters } });
        this.shape = shape;
        this.discardMedia = shape.discardMedia === true;
        this.log(`link → ${JSON.stringify(shape)} (${why})`);
    }

    #listen(socket) {
        return new Promise((ready) => socket.bind(0, '127.0.0.1', () => ready(socket.address().port)));
    }

    #open() {
        const socket = createSocket('udp4');
        this.sockets.add(socket);
        socket.on('error', (error) => this.log(`link socket error: ${error.message}`));
        return socket;
    }

    async #ready(generation) {
        let route = this.#routes.get(generation);
        if (!route) {
            route = { generation, host: null, browser: null, advertised: false, toBrowser: this.#open() };
            this.#routes.set(generation, route);
            route.toBrowser.on('message', payload => this.#forward(payload, route.browser, route.toEngine, 'toBrowser', route));
            route.ready = Promise.all([this.#browserSide(route), this.#listen(route.toBrowser)]);
        }
        await route.ready;
        return route;
    }

    async #browserSide(route) {
        route.toEngine = this.#open();
        route.toEngine.on('message', (payload, from) => {
            route.browser = { ip: from.address, port: from.port };
            this.browser = route.browser;
            this.#forward(payload, route.host, route.toBrowser, 'toEngine', route);
        });
        return this.#listen(route.toEngine);
    }

    // Retire the advertised browser-facing address. No packets on the old
    // tuple can discover its replacement; a fresh offer must advertise it.
    async rebindBrowserSide() {
        for (const route of this.#routes.values()) {
            const oldPort = route.toEngine.address().port;
            route.toEngine.close();
            this.sockets.delete(route.toEngine);
            route.browser = null;
            const newPort = await this.#browserSide(route);
            this.log(`link generation ${route.generation} browser-side rebind ${oldPort} → ${newPort}`);
        }
    }

    /** Forward one datagram in one direction, out of that direction's socket. */
    #forward(payload, to, socket, direction, route) {
        if (this.discardMedia && isMedia(payload)) {
            this.counters.mediaDiscarded += 1;
            return;
        }
        if (this.shape.discard === true) {
            this.counters.discarded += 1;
            return;
        }
        const delay = this.shape.delayMs ?? 0;
        const send = () => {
            // Re-checked when the delay is up: a shape may have changed, or the
            // run may have torn the link down, in between.
            if (this.shape.discard === true || socket.closed) {
                this.counters.discarded += 1;
                return;
            }
            if (to === null || to === undefined) {
                this.counters.unroutable += 1;
                return;
            }
            this.counters[direction] += 1;
            try {
                socket.send(payload, to.port, to.ip);
                if (direction === 'toBrowser' && isMedia(payload) && !route.mediaSeen) {
                    route.mediaSeen = true;
                    this.log(`link generation ${route.generation} media through 127.0.0.1:${socket.address().port}`);
                }
            } catch {
                // A datagram still inside a delay when the run ended. Nothing is
                // waiting on it, and a closed relay is not a failure.
                this.counters.discarded += 1;
            }
        };
        if (delay > 0) {
            this.counters.delayed += 1;
            const timer = setTimeout(send, delay);
            this.timers.add(timer);
            timer.unref?.();
            return;
        }
        send();
    }

    /**
     * The engine's candidate for this generation, as the browser should be told
     * about it: the real address, replaced by the relay's `browserIn` socket.
     *
     * Only the first usable candidate of each generation is advertised. One
     * reachable candidate is what a session needs, and advertising every
     * interface would mean a relay per interface and no single "the path" to
     * shape.
     */
    async down(line, generation) {
        const candidate = parseCandidate(line);
        if (candidate === null || candidate.type !== 'host' || candidate.proto.toLowerCase() !== 'udp') return null;
        if (!this.local.has(candidate.ip)) {
            this.log(`link engine candidate ${candidate.ip}:${candidate.port} is not a local address; dropping it`);
            return null;
        }
        // One generation's candidates arrive as a burst and are handled here
        // concurrently, so they are taken in order: exactly one is advertised,
        // and the rest are dropped rather than each opening a relay.
        const answer = this.#queue.then(async () => {
            const route = await this.#ready(generation);
            if (route.host !== null) return null;
            const toEngine = route.toEngine.address().port;
            this.host = route.host = { ip: candidate.ip, port: candidate.port, generation };
            this.log(`link engine candidate ${candidate.ip}:${candidate.port} (generation ${generation}) → browser through 127.0.0.1:${toEngine}`);
            return renderCandidate(candidate, '127.0.0.1', toEngine);
        });
        this.#queue = answer.then(() => undefined, () => undefined);
        return answer;
    }

    /**
     * The browser's candidate, as the engine should be told about it.
     *
     * Only the first of a session, for the same reason the engine's side keeps
     * only one: the engine picks a remote candidate and commits to it, and
     * giving it several makes it run two browser sockets at once.
     */
    async up(line, generation) {
        const candidate = parseCandidate(line);
        if (candidate === null || candidate.type !== 'host' || candidate.proto.toLowerCase() !== 'udp') return null;
        if (!this.local.has(candidate.ip)) {
            this.log(`link browser candidate ${candidate.ip}:${candidate.port} is not a local address; dropping it`);
            return null;
        }
        const route = await this.#ready(generation);
        if (route.advertised) return null;
        route.advertised = true;
        const toBrowser = route.toBrowser.address().port;
        // A hint only, and taken over by the first packet the browser sends,
        // which is how ICE itself finds a peer.
        this.log(`link browser candidate ${candidate.ip}:${candidate.port} → engine through 127.0.0.1:${toBrowser}`);
        return renderCandidate(candidate, '127.0.0.1', toBrowser);
    }

    close() {
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        for (const socket of this.sockets) {
            try {
                socket.close();
            } catch {
                // Already closed is not a teardown failure.
            }
        }
        this.sockets.clear();
    }
}

// ------------------------------------------------------- signalling relay ----
/**
 * The protocol channel, with the link rewriting applied to what crosses it.
 *
 * Everything else passes through untouched, in both directions: this is the
 * app's signalling channel, and the flow deliberately does not cut it.
 */
function startSignalling(link, bridgePort, token, { relayOnly = false } = {}) {
    const upstream = `ws://127.0.0.1:${bridgePort}/desktop?token=${token}`;
    let generation = 0;
    // Restart SDP can embed candidates without trickling them again. Rewrite
    // both directions, otherwise a direct candidate bypasses the shaped link.
    const rewriteSdp = async (description, direction) => {
        if (!relayOnly) return;
        const lines = [];
        for (const line of description.sdp.split('\r\n')) {
            if (line.startsWith('a=remote-candidates:')) continue;
            if (!line.startsWith('a=candidate:')) { lines.push(line); continue; }
            const rewritten = await link[direction](line.slice(2), generation);
            if (rewritten !== null) lines.push('a=' + rewritten);
        }
        description.sdp = lines.join('\r\n');
    };
    return new Promise((ready) => {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        server.on('connection', (client) => {
            const host = new WebSocket(upstream);
            const send = (socket, message) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
            // The page opens its socket the moment it loads, which can be before
            // the engine's socket is up. Anything the page sends before then has
            // to wait for it: a dropped `session.open` is a session that never
            // answers, which reads as a broken engine rather than a race.
            const hostReady = new Promise((ready, fail) => {
                host.once('open', ready);
                host.once('error', fail);
                host.once('close', () => fail(new Error('the engine channel closed before the page sent anything')));
            });
            host.on('message', async (raw) => {
                try {
                    const message = JSON.parse(String(raw));
                    if (message.event === 'session.description') {
                        // A re-offer is a new ICE generation; its candidates need
                        // their own relay socket, so the count advances here.
                        generation += 1;
                        await rewriteSdp(message.params.description, 'down');
                    }
                    if (message.event === 'session.candidate') {
                        const rewritten = await link.down(String(message.params.candidate), generation);
                        if (rewritten === null) return;
                        message.params.candidate = rewritten;
                    }
                    send(client, message);
                } catch (error) {
                    link.log(`signalling downstream error: ${error instanceof Error ? error.message : error}`);
                    try { client.close(); } catch { /* already closed */ }
                }
            });
            client.on('message', async (raw) => {
                try {
                    await hostReady;
                    const message = JSON.parse(String(raw));
                    if (message.method === 'session.open') link.newSession();
                    if (message.method === 'session.description') await rewriteSdp(message.params.description, 'up');
                    if (message.method === 'session.candidate' && typeof message.params?.candidate === 'string') {
                        const rewritten = await link.up(message.params.candidate, generation);
                        if (rewritten === null) return;
                        message.params.candidate = rewritten;
                    }
                    send(host, message);
                } catch (error) {
                    link.log(`signalling upstream not ready: ${error instanceof Error ? error.message : error}`);
                    try { client.close(); } catch { /* already closed */ }
                }
            });
            host.on('close', () => client.close());
            host.on('error', (error) => link.log(`signalling upstream error: ${error.message}`));
            client.on('close', () => host.close());
            client.on('error', () => host.close());
        });
        server.on('listening', () => ready({ port: server.address().port, close: () => server.close() }));
    });
}

export { ShapedLink, startSignalling };
