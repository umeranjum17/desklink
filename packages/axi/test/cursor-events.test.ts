import { describe, expect, it } from 'vitest';
import { CursorEventBuffer, formatCursorSamples } from '../src/cursor-events';

describe('cursor event delivery', () => {
  it('returns source position samples for the requested session', () => {
    const buffer = new CursorEventBuffer();
    buffer.push({ event: 'session.cursor', params: { sessionId: 'session-1', x: 31, y: 47, visible: true, timestamp_us: 1234 } });
    buffer.push({ event: 'session.cursor', params: { sessionId: 'stale-session', x: 99, y: 101, visible: false, timestamp_us: 2345 } });

    expect(formatCursorSamples(buffer.take('session-1'))).toBe(
      'cursor[1]{sessionId,x,y,visible,timestamp_us}:\n  {"sessionId":"session-1","x":31,"y":47,"visible":true,"timestamp_us":1234}',
    );
    expect(buffer.take('session-1')).toEqual([]);
  });
});
