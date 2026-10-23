/**
 * A text caret blinks, so two captures of the same screen differ in a thin
 * tall column where it toggled. Frames carry pixels without caret identity and
 * Tesseract reads a visible caret as a pipe, so these columns are painted out
 * of `next` (BGRX, same size as `previous`) before OCR. Wider changes are real
 * content and stay.
 */
const MIN_RUN = 8;
const MAX_RUN = 64;
const MAX_WIDTH = 3;
const DIFFERS = 96;

export function maskBlinkedCarets(previous: Buffer, next: Buffer, width: number, height: number): number {
  const differs = (at: number) => Math.abs(previous[at]! - next[at]!) + Math.abs(previous[at + 1]! - next[at + 1]!) + Math.abs(previous[at + 2]! - next[at + 2]!) >= DIFFERS;
  const runs: Array<{ x: number; start: number; end: number }> = [];
  for (let x = 1; x < width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      if (y < height && differs((y * width + x) * 4)) { if (start < 0) start = y; continue; }
      if (start >= 0 && y - start >= MIN_RUN && y - start <= MAX_RUN) runs.push({ x, start, end: y });
      start = -1;
    }
  }
  let masked = 0;
  for (let i = 0; i < runs.length;) {
    let j = i + 1;
    while (j < runs.length && runs[j]!.x === runs[j - 1]!.x + 1) j++;
    if (j - i <= MAX_WIDTH) {
      const fill = runs[i]!.x - 1;
      for (const run of runs.slice(i, j)) for (let y = run.start; y < run.end; y++) {
        const at = (y * width + run.x) * 4, from = (y * width + fill) * 4;
        for (let c = 0; c < 3; c++) next[at + c] = next[from + c]!;
        masked++;
      }
    }
    i = j;
  }
  return masked;
}
