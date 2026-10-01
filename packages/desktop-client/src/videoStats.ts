/** Keep receiver diagnostics useful without disclosing ICE addresses or credentials. */
export function videoStats(report: { forEach(callback: (stat: Record<string, unknown>) => void): void }): string {
    const fields = new Set([
        'id', 'type', 'timestamp', 'kind', 'mediaType', 'codecId', 'mimeType', 'clockRate', 'payloadType',
        'packetsReceived', 'packetsLost', 'bytesReceived', 'framesReceived', 'framesDecoded',
        'keyFramesDecoded', 'framesDropped', 'framesPerSecond', 'frameWidth', 'frameHeight',
        'nackCount', 'pliCount', 'firCount', 'totalDecodeTime', 'decoderImplementation', 'jitterBufferDelay',
    ]);
    const stats: Array<Record<string, unknown>> = [];
    report.forEach((stat) => {
        if (stat.type === 'inbound-rtp' || stat.type === 'codec') {
            stats.push(Object.fromEntries(Object.entries(stat).filter(([key]) => fields.has(key))));
        }
    });
    return JSON.stringify(stats);
}
