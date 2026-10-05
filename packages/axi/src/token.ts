import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Scoped by the session, exactly like the socket and the browser state beside
// it: one shared name per user let a second lane's grant overwrite the first
// lane's single-use token, and each lane's consumer then read the other's.
export function tokenPath(): string {
  return process.env.DESKLINK_AXI_RESTORE_TOKEN_FILE
    ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'desklink-axi',
      `${process.env.DESKLINK_AXI_SESSION ?? 'default'}.portal-token`);
}

// A portal token is single-use. Remove it from the reusable name before open;
// a failed open must prompt again rather than replay a possibly consumed grant.
export function takeToken(path: string): string | undefined {
  const claimed = `${path}.${randomUUID()}.used`;
  try { renameSync(path, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try { return readFileSync(claimed, 'utf8').trim() || undefined; }
  finally { rmSync(claimed); }
}

export function saveToken(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, token);
    closeSync(fd);
    renameSync(temporary, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(temporary, { force: true });
    throw error;
  }
}
