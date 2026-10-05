import { expect, it } from 'vitest';

// TEMPORARY red proof: passes on Linux, fails on the Windows runner.
it('red proof', () => {
    expect(process.platform).toBe('linux');
});