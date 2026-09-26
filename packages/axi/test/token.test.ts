import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveToken, takeToken } from '../src/token.js';

describe('portal restore token', () => {
  it('atomically saves mode 0600, consumes once, and rotates a returned token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'desklink-token-'));
    const path = join(dir, 'state', 'portal-token');
    try {
      saveToken(path, 'first-secret');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('first-secret');
      expect(takeToken(path)).toBe('first-secret');
      expect(takeToken(path)).toBeUndefined();
      saveToken(path, 'rotated-secret');
      expect(takeToken(path)).toBe('rotated-secret');
      expect(readdirSync(join(dir, 'state'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
