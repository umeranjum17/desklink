import type { EngineEvent } from '@desklink/host';

export type CursorSample = Extract<EngineEvent, { event: 'session.cursor' }>['params'];

export const CURSOR_EVENT_BUFFER_CAPACITY = 10_000;

export class CursorEventBuffer {
  private readonly samples: Array<CursorSample | undefined> = new Array(CURSOR_EVENT_BUFFER_CAPACITY);
  private head = 0;
  private size = 0;
  private dropped = 0;

  push(event: Extract<EngineEvent, { event: 'session.cursor' }>): void {
    if (this.size === CURSOR_EVENT_BUFFER_CAPACITY) {
      this.samples[this.head] = event.params;
      this.head = (this.head + 1) % CURSOR_EVENT_BUFFER_CAPACITY;
      this.dropped++;
      return;
    }
    this.samples[(this.head + this.size) % CURSOR_EVENT_BUFFER_CAPACITY] = event.params;
    this.size++;
  }

  take(sessionId: string): { samples: CursorSample[]; dropped: number } {
    const samples: CursorSample[] = [];
    for (let index = 0; index < this.size; index++) {
      const slot = (this.head + index) % CURSOR_EVENT_BUFFER_CAPACITY;
      const sample = this.samples[slot];
      if (sample?.sessionId === sessionId) samples.push(sample);
      this.samples[slot] = undefined;
    }
    const dropped = this.dropped;
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
    return { samples, dropped };
  }
}

export function formatCursorSamples(samples: CursorSample[], dropped: number): string {
  return samples.length
    ? `cursor[${samples.length}] dropped:${dropped} {sessionId,x,y,visible,timestamp_us}:\n${samples.map(sample => `  ${JSON.stringify(sample)}`).join('\n')}`
    : `cursor: no pending samples; dropped:${dropped}`;
}
