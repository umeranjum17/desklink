import type { EngineEvent } from '@desklink/host';

export type CursorSample = Extract<EngineEvent, { event: 'session.cursor' }>['params'];

export class CursorEventBuffer {
  private readonly samples: CursorSample[] = [];

  push(event: Extract<EngineEvent, { event: 'session.cursor' }>): void {
    this.samples.push(event.params);
  }

  take(sessionId: string): CursorSample[] {
    const samples = this.samples.filter(sample => sample.sessionId === sessionId);
    this.samples.length = 0;
    return samples;
  }
}

export function formatCursorSamples(samples: CursorSample[]): string {
  return samples.length
    ? `cursor[${samples.length}]{sessionId,x,y,visible,timestamp_us}:\n${samples.map(sample => `  ${JSON.stringify(sample)}`).join('\n')}`
    : 'cursor: no pending samples';
}
