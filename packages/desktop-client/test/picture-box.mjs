export function pictureBox(png, width) {
    const light = (x, y) => {
        const i = (y * png.width + x) * 4;
        return png.data[i] + png.data[i + 1] + png.data[i + 2] > 600;
    };
    const middle = Math.round(png.width * 0.6);
    let top = 0; while (top < png.height && !light(middle, top)) top++;
    let bottom = top; while (bottom < png.height && light(middle, bottom)) bottom++;
    let left = 0; while (left < png.width && !light(left, Math.min(top + 4, bottom - 1))) left++;
    const density = png.width / width;
    return { top: top / density, left: left / density, bottom: bottom / density };
}
