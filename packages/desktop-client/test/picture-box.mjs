export function pictureBox(png, width, floor = 600) {
    // What counts as picture: near-white callers keep the default; a caller
    // facing saturated fixture colors passes a lower floor instead.
    const light = (x, y) => {
        const i = (y * png.width + x) * 4;
        return png.data[i] + png.data[i + 1] + png.data[i + 2] > floor;
    };
    const middle = Math.round(png.width * 0.6);
    let top = 0; while (top < png.height && !light(middle, top)) top++;
    let bottom = top; while (bottom < png.height && light(middle, bottom)) bottom++;
    let left = 0; while (left < png.width && !light(left, Math.min(top + 4, bottom - 1))) left++;
    // The band's right edge, scanned back from the screen's edge on the same
    // row: a tap needs the picture's center, and a cover proof needs its width.
    let right = left;
    if (bottom > top) {
        const row = Math.min(top + 4, bottom - 1);
        right = png.width - 1;
        while (right > left && !light(right, row)) right--;
    }
    const density = png.width / width;
    return { top: top / density, left: left / density, bottom: bottom / density, right: right / density };
}
