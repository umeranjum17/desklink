//! Pixel conversion and downscale into the I420 plane layout libvpx encodes.
//!
//! Deliberately dependency-free: the source format a compositor actually offers
//! over PipeWire is a packed 4-byte one (`BGRx`/`RGBx`/`BGRA`/`RGBA`), and a box
//! downscale is the correct filter when the encoded surface is smaller than the
//! source — it is the only one that does not alias the desktop's text.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PixelFormat {
    Bgrx,
    Rgbx,
    Bgra,
    Rgba,
    Bgr,
    Rgb,
    Unsupported,
}

/// A tightly packed I420 frame; the plane strides are the frame width/2 so the
/// buffer is exactly what `vpx_image_t` wants when we hand libvpx three planes.
pub struct I420 {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl I420 {
    fn new(width: usize, height: usize) -> Self {
        let y = width * height;
        let c = (width / 2) * (height / 2);
        Self {
            width,
            height,
            data: vec![0u8; y + 2 * c],
        }
    }

    pub fn y_plane(&self) -> &[u8] {
        &self.data[..self.width * self.height]
    }

    pub fn u_plane(&self) -> &[u8] {
        let y = self.width * self.height;
        &self.data[y..y + (self.width / 2) * (self.height / 2)]
    }

    pub fn v_plane(&self) -> &[u8] {
        let y = self.width * self.height;
        let c = (self.width / 2) * (self.height / 2);
        &self.data[y + c..y + 2 * c]
    }
}

#[inline]
fn luma(r: i32, g: i32, b: i32) -> u8 {
    // BT.601 limited range, integer weights (the classic libyuv-equivalent form).
    (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(0, 255) as u8
}

#[inline]
fn chroma(r: i32, g: i32, b: i32) -> (u8, u8) {
    let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    (u.clamp(0, 255) as u8, v.clamp(0, 255) as u8)
}

/// Fit a source into a box without upscaling and with even dimensions, because
/// I420 chroma is subsampled and the encoder refuses a frame whose size is not
/// the one it was built for. This is the single definition of that rule: the
/// encoder's geometry, the portal frames and the X11 frames all call it.
pub fn fit(width: usize, height: usize, max_width: usize, max_height: usize) -> (usize, usize) {
    if max_width == 0 || max_height == 0 || (width <= max_width && height <= max_height) {
        return (width & !1, height & !1);
    }
    let scale = f64::min(
        max_width as f64 / width as f64,
        max_height as f64 / height as f64,
    );
    (
        (((width as f64 * scale) as usize) & !1).max(2),
        (((height as f64 * scale) as usize) & !1).max(2),
    )
}

/// Which bytes of a source pixel are red, green and blue, and how wide it is.
fn layout(format: PixelFormat) -> Option<(usize, [usize; 3])> {
    match format {
        PixelFormat::Bgrx | PixelFormat::Bgra => Some((4, [2, 1, 0])),
        PixelFormat::Rgbx | PixelFormat::Rgba => Some((4, [0, 1, 2])),
        PixelFormat::Bgr => Some((3, [2, 1, 0])),
        PixelFormat::Rgb => Some((3, [0, 1, 2])),
        PixelFormat::Unsupported => None,
    }
}

/// A tightly packed pre-encode BGRX frame for still observations. At native
/// resolution this copies each source colour exactly; a smaller encode box
/// necessarily samples down to the geometry input uses.
pub fn to_bgrx(
    src: &[u8],
    src_w: usize,
    src_h: usize,
    stride: usize,
    format: PixelFormat,
    width: usize,
    height: usize,
) -> Option<Vec<u8>> {
    let (bytes, rgb) = layout(format)?;
    let mut out = Vec::with_capacity(width * height * 4);
    if matches!(format, PixelFormat::Bgrx | PixelFormat::Bgra) && width == src_w && height == src_h
    {
        for row in 0..height {
            out.extend_from_slice(src.get(row * stride..row * stride + width * 4)?);
        }
        return Some(out);
    }
    for y in 0..height {
        for x in 0..width {
            let sx = x * src_w / width;
            let sy = y * src_h / height;
            let at = sy * stride + sx * bytes;
            let pixel = src.get(at..at + bytes)?;
            out.extend_from_slice(&[pixel[rgb[2]], pixel[rgb[1]], pixel[rgb[0]], 255]);
        }
    }
    Some(out)
}

/// How many threads convert one frame. A 4K desktop is 8 million pixels, which
/// one core converts in tens of milliseconds, the whole budget of a frame; a few
/// bands bring that under the encoder's own cost without taking the machine.
fn bands() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8)
}

/// Convert `src` (packed RGB of some byte order) to `dst_w`x`dst_h` I420.
///
/// At the source's own size every pixel is converted as it is, which is what
/// keeps text sharp; smaller, each destination pixel is the box average of the
/// source pixels it covers, the only downscale filter that does not alias text;
/// larger (a stream a few pixels short of the encoder's size), the nearest
/// source pixel.
/// Chroma is the average of each 2x2 block. `src_stride` is in bytes. Returns
/// `None` for a format we cannot read, so the caller reports an unsupported
/// source instead of encoding noise.
pub fn to_i420(
    src: &[u8],
    src_w: usize,
    src_h: usize,
    src_stride: usize,
    format: PixelFormat,
    dst_w: usize,
    dst_h: usize,
) -> Option<I420> {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return None;
    }
    // I420 chroma is subsampled 2x2, so an odd destination would leave a
    // half-populated chroma plane. Even dimensions are the caller's contract and
    // the encoder's; enforcing it here keeps the buffer self-consistent.
    let dst_w = dst_w & !1;
    let dst_h = dst_h & !1;
    if dst_w < 2 || dst_h < 2 {
        return None;
    }
    let (bytes_per_pixel, order) = layout(format)?;
    if src_stride < src_w * bytes_per_pixel
        || src.len() < src_stride * (src_h - 1) + src_w * bytes_per_pixel
    {
        return None;
    }
    let mut out = I420::new(dst_w, dst_h);
    let (y_plane, chroma) = out.data.split_at_mut(dst_w * dst_h);
    let (u_plane, v_plane) = chroma.split_at_mut((dst_w / 2) * (dst_h / 2));

    // Bands of whole row pairs, so each thread owns disjoint luma and chroma rows.
    let pairs = dst_h / 2;
    let per_band = pairs.div_ceil(bands());
    let cw = dst_w / 2;
    let source = Source {
        data: src,
        width: src_w,
        height: src_h,
        stride: src_stride,
        bytes_per_pixel,
        order,
        columns: spans(src_w, dst_w),
        rows: spans(src_h, dst_h),
    };
    std::thread::scope(|scope| {
        let y_bands = y_plane.chunks_mut(per_band * 2 * dst_w);
        let u_bands = u_plane.chunks_mut(per_band * cw);
        let v_bands = v_plane.chunks_mut(per_band * cw);
        for (band, ((y, u), v)) in y_bands.zip(u_bands).zip(v_bands).enumerate() {
            let source = &source;
            scope.spawn(move || {
                let first_pair = band * per_band;
                // One destination row of box sums, reused for every row.
                let mut rgb = vec![[0i32; 3]; dst_w * 2];
                for pair in 0..u.len() / cw {
                    let dy = (first_pair + pair) * 2;
                    let (top, bottom) =
                        y[pair * 2 * dst_w..(pair + 1) * 2 * dst_w].split_at_mut(dst_w);
                    let u_row = &mut u[pair * cw..(pair + 1) * cw];
                    let v_row = &mut v[pair * cw..(pair + 1) * cw];
                    if source.native(dst_w, dst_h) && bytes_per_pixel == 4 {
                        source.native_pair(dy, top, bottom, u_row, v_row);
                    } else {
                        let (a, b) = rgb.split_at_mut(dst_w);
                        source.box_row(dy, a);
                        source.box_row(dy + 1, b);
                        pack(a, b, top, bottom, u_row, v_row);
                    }
                }
            });
        }
    });
    Some(out)
}

/// The source span `[start, end)` each of `dst` destination pixels covers: the
/// box a downscale averages, or at least the one nearest pixel when the
/// destination is a little larger than the source.
fn spans(src: usize, dst: usize) -> Vec<(usize, usize)> {
    (0..dst)
        .map(|d| {
            let start = d * src / dst;
            (start, ((d + 1) * src).div_ceil(dst).clamp(start + 1, src))
        })
        .collect()
}

struct Source<'a> {
    data: &'a [u8],
    width: usize,
    height: usize,
    stride: usize,
    bytes_per_pixel: usize,
    order: [usize; 3],
    columns: Vec<(usize, usize)>,
    rows: Vec<(usize, usize)>,
}

impl Source<'_> {
    fn native(&self, dst_w: usize, dst_h: usize) -> bool {
        dst_w == self.width && dst_h == self.height
    }

    /// Destination row `dy` as the average colour of the source box each pixel
    /// covers (at the source's own size, a box of one pixel: its exact colour).
    fn box_row(&self, dy: usize, out: &mut [[i32; 3]]) {
        let (y0, y1) = self.rows[dy];
        out.fill([0; 3]);
        for y in y0..y1 {
            let line = &self.data[y * self.stride..];
            for (sum, &(x0, x1)) in out.iter_mut().zip(&self.columns) {
                for pixel in line[x0 * self.bytes_per_pixel..x1 * self.bytes_per_pixel]
                    .chunks_exact(self.bytes_per_pixel)
                {
                    sum[0] += pixel[self.order[0]] as i32;
                    sum[1] += pixel[self.order[1]] as i32;
                    sum[2] += pixel[self.order[2]] as i32;
                }
            }
        }
        let height = (y1 - y0) as i32;
        for (sum, &(x0, x1)) in out.iter_mut().zip(&self.columns) {
            let n = (x1 - x0) as i32 * height;
            *sum = [sum[0] / n, sum[1] / n, sum[2] / n];
        }
    }

    /// A 4-byte source at its own size: the path every full-size desktop takes,
    /// so it reads the two rows directly and in a shape the compiler vectorises.
    fn native_pair(
        &self,
        dy: usize,
        top: &mut [u8],
        bottom: &mut [u8],
        u: &mut [u8],
        v: &mut [u8],
    ) {
        let width = top.len();
        let row = |y: usize| &self.data[y * self.stride..y * self.stride + width * 4];
        let (upper, lower) = (row(dy), row(dy + 1));
        #[cfg(target_arch = "x86_64")]
        if std::arch::is_x86_feature_detected!("avx2") {
            // SAFETY: the CPU was just checked for AVX2.
            unsafe {
                return match self.order {
                    [2, 1, 0] => pair4_avx2::<2, 1, 0>(upper, lower, top, bottom, u, v),
                    _ => pair4_avx2::<0, 1, 2>(upper, lower, top, bottom, u, v),
                };
            }
        }
        match self.order {
            [2, 1, 0] => pair4::<2, 1, 0>(upper, lower, top, bottom, u, v),
            _ => pair4::<0, 1, 2>(upper, lower, top, bottom, u, v),
        }
    }
}

/// `pair4` compiled for AVX2, for the x86-64 machines that have it; the build
/// itself targets the x86-64 baseline.
#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn pair4_avx2<const R: usize, const G: usize, const B: usize>(
    upper: &[u8],
    lower: &[u8],
    top: &mut [u8],
    bottom: &mut [u8],
    u: &mut [u8],
    v: &mut [u8],
) {
    pair4::<R, G, B>(upper, lower, top, bottom, u, v)
}

#[inline(always)]
fn pair4<const R: usize, const G: usize, const B: usize>(
    upper: &[u8],
    lower: &[u8],
    top: &mut [u8],
    bottom: &mut [u8],
    u: &mut [u8],
    v: &mut [u8],
) {
    // The same integer formulas as `luma` and `chroma`, in 16 bits: every
    // intermediate fits (luma below 2^16 unsigned, chroma within ±2^15) and the
    // results need no clamp, which lets the compiler use 16-bit vector lanes.
    for (src, dst) in [(upper, &mut *top), (lower, &mut *bottom)] {
        for (pixel, y) in src.chunks_exact(4).zip(dst.iter_mut()) {
            let (r, g, b) = (pixel[R] as u16, pixel[G] as u16, pixel[B] as u16);
            *y = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8;
        }
    }
    let blocks = upper.chunks_exact(8).zip(lower.chunks_exact(8));
    for ((a, b), (u, v)) in blocks.zip(u.iter_mut().zip(v.iter_mut())) {
        let sum = |c: usize| {
            ((a[c] as u16 + a[c + 4] as u16 + b[c] as u16 + b[c + 4] as u16 + 2) >> 2) as i16
        };
        let (r, g, b) = (sum(R), sum(G), sum(B));
        *u = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128) as u8;
        *v = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128) as u8;
    }
}

/// Two rows of RGB into two luma rows and the chroma row they share, chroma
/// being the average of each 2x2 block.
fn pack(
    a: &[[i32; 3]],
    b: &[[i32; 3]],
    top: &mut [u8],
    bottom: &mut [u8],
    u: &mut [u8],
    v: &mut [u8],
) {
    for (p, y) in a
        .iter()
        .zip(top.iter_mut())
        .chain(b.iter().zip(bottom.iter_mut()))
    {
        *y = luma(p[0], p[1], p[2]);
    }
    for (cx, (u, v)) in u.iter_mut().zip(v.iter_mut()).enumerate() {
        let sum =
            |c: usize| (a[cx * 2][c] + a[cx * 2 + 1][c] + b[cx * 2][c] + b[cx * 2 + 1][c] + 2) >> 2;
        (*u, *v) = chroma(sum(0), sum(1), sum(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscale_keeps_average_colour_and_plane_sizes() {
        // 4x4 opaque red desktop in BGRx, downscaled to 2x2.
        let mut src = vec![0u8; 4 * 16];
        for px in src.chunks_exact_mut(4) {
            px[0] = 0; // B
            px[1] = 0; // G
            px[2] = 255; // R
            px[3] = 255; // X
        }
        let out = to_i420(&src, 4, 4, 16, PixelFormat::Bgrx, 2, 2).unwrap();
        assert_eq!(out.data.len(), 4 + 2 * 1);
        assert!(
            out.y_plane().iter().all(|&y| y > 70),
            "red luma should be high"
        );
        assert!(out.u_plane().iter().all(|&u| u < 128), "red has low Cb");
        assert!(out.v_plane().iter().all(|&v| v > 200), "red has high Cr");
    }

    #[test]
    fn odd_destination_is_clamped_to_whole_chroma_blocks() {
        let src = vec![255u8; 4 * 16];
        let out = to_i420(&src, 4, 4, 16, PixelFormat::Bgrx, 3, 3).unwrap();
        assert_eq!((out.width, out.height), (2, 2));
        assert_eq!(out.data.len(), 4 + 2 * 1);
    }

    #[test]
    fn a_stream_a_few_pixels_off_the_encoders_size_is_converted_to_exactly_that_size() {
        // A fractional-scaled display reports one size to the portal and
        // streams another; the encoder only accepts its own.
        let src = vec![200u8; 4 * 1704 * 1066];
        let out = to_i420(&src, 1704, 1066, 1704 * 4, PixelFormat::Bgrx, 1706, 1066).unwrap();
        assert_eq!((out.width, out.height), (1706, 1066));
        let out = to_i420(&src, 1704, 1066, 1704 * 4, PixelFormat::Bgrx, 1702, 1064).unwrap();
        assert_eq!((out.width, out.height), (1702, 1064));
    }

    #[test]
    fn still_pixels_keep_exact_source_colours_before_encoding() {
        let src = [1, 2, 3, 0, 4, 5, 6, 0];
        assert_eq!(
            to_bgrx(&src, 2, 1, 8, PixelFormat::Bgrx, 2, 1).unwrap(),
            src
        );
        assert_eq!(
            to_bgrx(&src, 2, 1, 8, PixelFormat::Rgbx, 2, 1).unwrap(),
            [3, 2, 1, 255, 6, 5, 4, 255]
        );
    }

    /// The per-pixel conversion this module used to run, kept as the definition
    /// the fast paths must reproduce bit for bit.
    fn reference(
        src: &[u8],
        sw: usize,
        sh: usize,
        stride: usize,
        format: PixelFormat,
        dw: usize,
        dh: usize,
    ) -> Vec<u8> {
        let (bpp, o) = layout(format).unwrap();
        let rgb = |x: usize, y: usize| {
            let p = &src[y * stride + x * bpp..];
            (p[o[0]] as i32, p[o[1]] as i32, p[o[2]] as i32)
        };
        let sample = |dx: usize, dy: usize| {
            let x0 = dx * sw / dw;
            let x1 = ((dx + 1) * sw).div_ceil(dw).clamp(x0 + 1, sw);
            let y0 = dy * sh / dh;
            let y1 = ((dy + 1) * sh).div_ceil(dh).clamp(y0 + 1, sh);
            let (mut r, mut g, mut b) = (0, 0, 0);
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = rgb(x, y);
                    (r, g, b) = (r + p.0, g + p.1, b + p.2);
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as i32;
            (r / n, g / n, b / n)
        };
        let (mut y, mut u, mut v) = (vec![0; dw * dh], vec![], vec![]);
        for cy in 0..dh / 2 {
            for cx in 0..dw / 2 {
                let px = [(0, 0), (1, 0), (0, 1), (1, 1)]
                    .map(|(i, j)| (cx * 2 + i, cy * 2 + j, sample(cx * 2 + i, cy * 2 + j)));
                for (x, yy, p) in px {
                    y[yy * dw + x] = luma(p.0, p.1, p.2);
                }
                let s = |f: fn(&(i32, i32, i32)) -> i32| {
                    (px.iter().map(|p| f(&p.2)).sum::<i32>() + 2) >> 2
                };
                let (cu, cv) = chroma(s(|p| p.0), s(|p| p.1), s(|p| p.2));
                u.push(cu);
                v.push(cv);
            }
        }
        [y, u, v].concat()
    }

    #[test]
    fn every_path_matches_the_per_pixel_definition_exactly() {
        let mut seed = 0x9e3779b9u32;
        let mut noise = |n: usize| {
            (0..n)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    seed as u8
                })
                .collect::<Vec<u8>>()
        };
        let formats = [
            PixelFormat::Bgrx,
            PixelFormat::Rgba,
            PixelFormat::Bgr,
            PixelFormat::Rgb,
        ];
        for (sw, sh, dw, dh) in [
            (64, 36, 64, 36),
            (67, 41, 66, 40),
            (100, 60, 38, 22),
            (90, 50, 92, 50),
            (33, 17, 8, 6),
        ] {
            for format in formats {
                let bpp = layout(format).unwrap().0;
                let stride = sw * bpp + 12;
                let src = noise(stride * sh);
                let fast = to_i420(&src, sw, sh, stride, format, dw, dh).unwrap();
                assert!(
                    fast.data == reference(&src, sw, sh, stride, format, dw & !1, dh & !1),
                    "{format:?} {sw}x{sh} -> {dw}x{dh}"
                );
            }
        }
    }

    #[test]
    fn padded_bgra_rows_remain_aligned_in_stills_and_video() {
        // ScreenCaptureKit pads 3420 BGRA pixels from 13680 to 13696 bytes/row.
        let src = [
            0, 0, 255, 255, 0, 0, 255, 255, 0, 255, 0, 0, // red row + green padding
            255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 0, // blue row + green padding
        ];
        assert_eq!(
            to_bgrx(&src, 2, 2, 12, PixelFormat::Bgra, 2, 2).unwrap(),
            [src[0..8].to_vec(), src[12..20].to_vec()].concat()
        );
        let video = to_i420(&src, 2, 2, 12, PixelFormat::Bgra, 2, 2).unwrap();
        assert_eq!(video.y_plane(), &[82, 82, 41, 41]);
    }

    #[test]
    fn unsupported_format_is_reported_not_guessed() {
        assert!(to_i420(&vec![0u8; 64], 4, 4, 16, PixelFormat::Unsupported, 2, 2).is_none());
    }
}
