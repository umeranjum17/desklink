// Set-of-marks overlay: numbered boxes drawn onto an RGBA crop buffer.
// Pure buffer math so it is unit-testable without a display; the caller
// encodes the PNG (pngjs is already a dependency).

export interface MarkBox {
  /** 1-based mark number printed inside the box chip. */
  mark: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

// 3x5 pixel digits, rows packed as 3-bit lines, top row first.
const DIGITS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
};

export const MARK_BORDER: [number, number, number] = [255, 59, 48]; // red
export const MARK_CHIP: [number, number, number] = [255, 214, 10]; // yellow

export function estimateMarksCost(width: number, height: number): number {
  return Math.round(width * height / 750);
}

function putPixel(data: Buffer, width: number, height: number, x: number, y: number, color: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const at = (y * width + x) * 4;
  data[at] = color[2];
  data[at + 1] = color[1];
  data[at + 2] = color[0];
  data[at + 3] = 255;
}

function fillRect(data: Buffer, width: number, height: number, x: number, y: number, w: number, h: number, color: [number, number, number]): void {
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) putPixel(data, width, height, x + col, y + row, color);
}

function drawDigit(data: Buffer, width: number, height: number, x: number, y: number, glyph: string, scale: number): number {
  const rows = DIGITS[glyph];
  if (!rows) return 0;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
    if (rows[r]! & (1 << (2 - c))) fillRect(data, width, height, x + c * scale, y + r * scale, scale, scale, [0, 0, 0]);
  }
  return 3 * scale;
}

/** Draw numbered boxes (2px border + numbered chip above each box). Mutates data. */
export function drawMarks(data: Buffer, width: number, height: number, boxes: MarkBox[], scale = 2): void {
  for (const box of boxes) {
    const { x, y, w, h } = box;
    if (w <= 0 || h <= 0) continue;
    for (let t = 0; t < 2; t++) {
      fillRect(data, width, height, x + t, y + t, w - 2 * t, 1, MARK_BORDER);
      fillRect(data, width, height, x + t, y + h - 1 - t, w - 2 * t, 1, MARK_BORDER);
      fillRect(data, width, height, x + t, y + t, 1, h - 2 * t, MARK_BORDER);
      fillRect(data, width, height, x + w - 1 - t, y + t, 1, h - 2 * t, MARK_BORDER);
    }
    const label = String(box.mark);
    const textW = label.length * 3 * scale + 2 * scale;
    const chipX = Math.min(Math.max(0, x), Math.max(0, width - textW));
    const chipY = y >= 9 * scale + 2 ? y - 9 * scale - 2 : y;
    fillRect(data, width, height, chipX, chipY, textW, 7 * scale + 2 * scale, MARK_CHIP);
    let cursor = chipX + scale;
    for (const glyph of label) cursor += drawDigit(data, width, height, cursor, chipY + scale, glyph, scale) + scale;
  }
}

/** Drop OCR candidates whose center falls inside an AX box (the AX ref is richer). */
export function dedupeCandidates<T extends { x: number; y: number; w: number; h: number }>(axBoxes: Array<{ x: number; y: number; w: number; h: number }>, ocr: T[]): T[] {
  return ocr.filter(item => {
    const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
    return !axBoxes.some(b => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h);
  });
}
