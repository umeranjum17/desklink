import { describe, expect, it } from 'vitest';
import { CURSOR_EVENT_BUFFER_CAPACITY, CursorEventBuffer, formatCursorSamples } from '../src/cursor-events';

describe('cursor event delivery', () => {
  it('returns source position samples for the requested session', () => {
    const buffer = new CursorEventBuffer();
    buffer.push({ event: 'session.cursor', params: { sessionId: 'session-1', x: 31, y: 47, visible: true, timestamp_us: 1234 } });
    buffer.push({ event: 'session.cursor', params: { sessionId: 'stale-session', x: 99, y: 101, visible: false, timestamp_us: 2345 } });

    const batch = buffer.take('session-1');
    expect(formatCursorSamples(batch.samples, batch.dropped)).toBe(
      'cursor[1] dropped:0 {sessionId,x,y,visible,timestamp_us,hotspot?}:\n  {"sessionId":"session-1","x":31,"y":47,"visible":true,"timestamp_us":1234}',
    );
    expect(buffer.take('session-1')).toEqual({ samples: [], dropped: 0 });
  });

  it('keeps the newest 10000 samples and reports overwritten samples once', () => {
    const buffer = new CursorEventBuffer();
    for (let x = 0; x < CURSOR_EVENT_BUFFER_CAPACITY + 2; x++) {
      buffer.push({ event: 'session.cursor', params: { sessionId: 'session-1', x, y: 0, visible: true, timestamp_us: x } });
    }

    const batch = buffer.take('session-1');
    expect(batch.samples).toHaveLength(CURSOR_EVENT_BUFFER_CAPACITY);
    expect(batch.samples[0]?.x).toBe(2);
    expect(batch.samples.at(-1)?.x).toBe(CURSOR_EVENT_BUFFER_CAPACITY + 1);
    expect(batch.dropped).toBe(2);
    expect(formatCursorSamples([], batch.dropped)).toBe('cursor: no pending samples; dropped:2');
    expect(buffer.take('session-1').dropped).toBe(0);
  });
});
