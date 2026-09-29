/*
 * Thin C surface over VideoToolbox's H.264 encoder.
 *
 * VideoToolbox is configured through CoreFoundation dictionaries and delivers
 * output on a callback; doing both here, next to the headers, keeps the Rust
 * side to an opaque handle, a status code and one Annex-B access unit.
 *
 * Every call is synchronous: a frame goes in, VTCompressionSessionCompleteFrames
 * flushes it, and the callback has stored its access unit before encode returns.
 * VideoToolbox is a system framework; nothing here is derived from any encoder
 * implementation.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <CoreFoundation/CoreFoundation.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <VideoToolbox/VideoToolbox.h>

/* H.264's own ceiling: no cap. Refinement frames lower it for one frame. */
#define DL_VT_MOTION_MAX_QP 51

/* Not an OSStatus: the encoder chose to drop the frame rather than fail. */
#define DL_VT_DROPPED 1

/* How many times one picture is offered to low-latency rate control before
 * the session falls back to the ordinary real-time mode. */
#define DL_VT_ATTEMPTS 4

/* Outside low-latency mode MaxAllowedFrameQP (and MinAllowedFrameQP) are
 * accepted but ignored, and the per-frame BaseFrameQP would have to be set on
 * every frame, so a refinement frame gets a rate target this many times the
 * session's instead. Rate control moves QP about 5 steps per frame whatever
 * the target, so the refinement lands about 5 below its neighbours: QP 20 when
 * they sit at 25, QP 40 when they sit at 45. */
#define DL_VT_REFINE_RATE_SCALE 16

typedef struct {
    VTCompressionSessionRef session;
    int width;
    int height;
    int fps;
    /* Low-latency rate control, when the machine's encoder offers it for
     * Constrained Baseline; otherwise the ordinary real-time mode, which needs
     * a hard data-rate cap to keep a key frame from flooding the link. */
    int low_latency;
    int bitrate_kbps;
    int64_t frame_index;
    /* The access unit the callback last produced, Annex-B. */
    uint8_t *out;
    size_t out_size;
    size_t out_cap;
    int out_is_key;
    OSStatus out_status;
    int out_ready;
} dl_vt_encoder;

static int append(dl_vt_encoder *self, const void *bytes, size_t size) {
    if (self->out_size + size > self->out_cap) {
        size_t cap = (self->out_size + size) * 2;
        uint8_t *grown = realloc(self->out, cap);
        if (grown == NULL) {
            return -1;
        }
        self->out = grown;
        self->out_cap = cap;
    }
    memcpy(self->out + self->out_size, bytes, size);
    self->out_size += size;
    return 0;
}

static const uint8_t START_CODE[4] = {0, 0, 0, 1};

/* The encoder writes length-prefixed NAL units and keeps SPS/PPS in the format
 * description; receivers want start codes and the parameter sets in-band, in
 * front of every IDR so a decoder can join at any of them. */
static OSStatus to_annex_b(dl_vt_encoder *self, CMSampleBufferRef sample) {
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    if (block == NULL || format == NULL) {
        return kVTParameterErr;
    }
    size_t size = CMBlockBufferGetDataLength(block);
    uint8_t *avcc = malloc(size);
    if (avcc == NULL) {
        return kVTAllocationFailedErr;
    }
    OSStatus status = CMBlockBufferCopyDataBytes(block, 0, size, avcc);
    size_t sets = 0;
    int length_size = 4;
    if (status == noErr) {
        status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, NULL, NULL, &sets,
                                                                    &length_size);
    }
    if (status != noErr || length_size < 1 || length_size > 4) {
        free(avcc);
        return status != noErr ? status : kVTParameterErr;
    }
    int idr = 0;
    for (size_t at = 0; at + length_size <= size;) {
        size_t nal = 0;
        for (int i = 0; i < length_size; i++) {
            nal = (nal << 8) | avcc[at + i];
        }
        at += length_size;
        if (nal == 0 || nal > size - at) {
            break;
        }
        if ((avcc[at] & 0x1f) == 5) {
            idr = 1;
        }
        at += nal;
    }
    if (idr) {
        for (size_t i = 0; i < sets && status == noErr; i++) {
            const uint8_t *set = NULL;
            size_t set_size = 0;
            status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, i, &set, &set_size,
                                                                        NULL, NULL);
            if (status == noErr && (append(self, START_CODE, 4) || append(self, set, set_size))) {
                status = kVTAllocationFailedErr;
            }
        }
    }
    for (size_t at = 0; status == noErr && at + length_size <= size;) {
        size_t nal = 0;
        for (int i = 0; i < length_size; i++) {
            nal = (nal << 8) | avcc[at + i];
        }
        at += length_size;
        if (nal == 0 || nal > size - at) {
            break;
        }
        if (append(self, START_CODE, 4) || append(self, avcc + at, nal)) {
            status = kVTAllocationFailedErr;
        }
        at += nal;
    }
    free(avcc);
    self->out_is_key = idr;
    return status;
}

static void on_output(void *refcon, void *frame_refcon, OSStatus status,
                      VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    (void)frame_refcon;
    dl_vt_encoder *self = refcon;
    self->out_ready = 1;
    if (status == noErr && ((flags & kVTEncodeInfo_FrameDropped) || sample == NULL)) {
        status = DL_VT_DROPPED;
    }
    self->out_status = status == noErr ? to_annex_b(self, sample) : status;
}

static OSStatus set_int(VTSessionRef session, CFStringRef key, int64_t value) {
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberSInt64Type, &value);
    OSStatus status = VTSessionSetProperty(session, key, number);
    CFRelease(number);
    return status;
}

/* A hard cap of 1.5x the target over one second: room for a key frame without
 * letting it take the link. Only used outside low-latency mode, which paces
 * itself. */
static OSStatus set_rate(dl_vt_encoder *self, int bitrate_kbps) {
    self->bitrate_kbps = bitrate_kbps;
    OSStatus status =
        set_int(self->session, kVTCompressionPropertyKey_AverageBitRate, (int64_t)bitrate_kbps * 1000);
    if (status != noErr || self->low_latency) {
        return status;
    }
    int64_t bytes = (int64_t)bitrate_kbps * 1000 * 3 / 2 / 8;
    double seconds = 1.0;
    CFNumberRef limit[2] = {CFNumberCreate(NULL, kCFNumberSInt64Type, &bytes),
                            CFNumberCreate(NULL, kCFNumberDoubleType, &seconds)};
    CFArrayRef limits = CFArrayCreate(NULL, (const void **)limit, 2, &kCFTypeArrayCallBacks);
    status = VTSessionSetProperty(self->session, kVTCompressionPropertyKey_DataRateLimits, limits);
    CFRelease(limits);
    CFRelease(limit[0]);
    CFRelease(limit[1]);
    return status;
}

static void close_session(dl_vt_encoder *self) {
    if (self->session != NULL) {
        VTCompressionSessionInvalidate(self->session);
        CFRelease(self->session);
        self->session = NULL;
    }
}

static OSStatus open_session(dl_vt_encoder *self, int low_latency, int bitrate_kbps) {
    CFMutableDictionaryRef spec = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks,
                                                            &kCFTypeDictionaryValueCallBacks);
    /* Required, not just enabled: the backend reports itself as hardware, and
     * a software fallback would code 4K at a fraction of the frame rate. */
    CFDictionarySetValue(spec, kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder,
                         kCFBooleanTrue);
    if (low_latency) {
        CFDictionarySetValue(spec, kVTVideoEncoderSpecification_EnableLowLatencyRateControl,
                             kCFBooleanTrue);
    }
    /* NV12 is what every hardware encoder takes without an internal copy. */
    int32_t pixel_format = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
    CFNumberRef format_number = CFNumberCreate(NULL, kCFNumberSInt32Type, &pixel_format);
    CFMutableDictionaryRef source = CFDictionaryCreateMutable(
        NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(source, kCVPixelBufferPixelFormatTypeKey, format_number);
    CFRelease(format_number);

    OSStatus status = VTCompressionSessionCreate(NULL, self->width, self->height,
                                                 kCMVideoCodecType_H264, spec, source, NULL,
                                                 on_output, self, &self->session);
    CFRelease(spec);
    CFRelease(source);
    if (status != noErr) {
        self->session = NULL;
        return status;
    }
    self->low_latency = low_latency;
    VTSessionRef s = self->session;
    /* Constrained Baseline is what every receiver decodes, an iPhone's hardware
     * decoder included; the profile itself rules out B-frames and CABAC. */
    status = VTSessionSetProperty(s, kVTCompressionPropertyKey_ProfileLevel,
                                  kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel);
    if (status == noErr) {
        status = VTSessionSetProperty(s, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    }
    if (status == noErr) {
        status = VTSessionSetProperty(s, kVTCompressionPropertyKey_AllowFrameReordering,
                                      kCFBooleanFalse);
    }
    /* Key frames only when asked, as with VP9: on a desktop a periodic IDR is
     * the most expensive frame and the one that softens a sharp picture. */
    if (status == noErr) {
        status = set_int(s, kVTCompressionPropertyKey_MaxKeyFrameInterval, INT32_MAX);
    }
    if (status == noErr) {
        status = set_int(s, kVTCompressionPropertyKey_ExpectedFrameRate, self->fps);
    }
    /* The converter produces BT.601 limited range, as the VP9 path signals;
     * without these in the VUI a receiver guesses BT.709 for HD and shifts
     * every colour. */
    if (status == noErr) {
        status = VTSessionSetProperty(s, kVTCompressionPropertyKey_YCbCrMatrix,
                                      kCVImageBufferYCbCrMatrix_ITU_R_601_4);
    }
    if (status == noErr) {
        status = VTSessionSetProperty(s, kVTCompressionPropertyKey_ColorPrimaries,
                                      kCVImageBufferColorPrimaries_SMPTE_C);
    }
    if (status == noErr) {
        status = VTSessionSetProperty(s, kVTCompressionPropertyKey_TransferFunction,
                                      kCVImageBufferTransferFunction_ITU_R_709_2);
    }
    if (status == noErr) {
        status = set_rate(self, bitrate_kbps);
    }
    if (status == noErr) {
        status = set_int(s, kVTCompressionPropertyKey_MaxAllowedFrameQP, DL_VT_MOTION_MAX_QP);
    }
    if (status == noErr) {
        status = VTCompressionSessionPrepareToEncodeFrames(self->session);
    }
    if (status != noErr) {
        close_session(self);
    }
    return status;
}

void dl_vt_destroy(dl_vt_encoder *self) {
    if (self == NULL) {
        return;
    }
    close_session(self);
    free(self->out);
    free(self);
}

/* Low-latency mode first; where the encoder will not do it for this profile or
 * size, the ordinary real-time mode. Returns the last refusal's status, with
 * *out left NULL. */
OSStatus dl_vt_create(int width, int height, int bitrate_kbps, int fps, dl_vt_encoder **out) {
    *out = NULL;
    if (width <= 0 || height <= 0 || bitrate_kbps <= 0 || fps <= 0) {
        return kVTParameterErr;
    }
    dl_vt_encoder *self = calloc(1, sizeof(dl_vt_encoder));
    if (self == NULL) {
        return kVTAllocationFailedErr;
    }
    self->width = width;
    self->height = height;
    self->fps = fps;
    OSStatus status = open_session(self, 1, bitrate_kbps);
    if (status != noErr) {
        status = open_session(self, 0, bitrate_kbps);
    }
    if (status != noErr) {
        dl_vt_destroy(self);
        return status;
    }
    *out = self;
    return noErr;
}

int dl_vt_low_latency(const dl_vt_encoder *self) { return self->low_latency; }

static OSStatus copy_i420(dl_vt_encoder *self, const uint8_t *i420, CVPixelBufferRef *out) {
    CVPixelBufferPoolRef pool = VTCompressionSessionGetPixelBufferPool(self->session);
    if (pool == NULL) {
        return kVTAllocationFailedErr;
    }
    CVPixelBufferRef buffer = NULL;
    CVReturn made = CVPixelBufferPoolCreatePixelBuffer(NULL, pool, &buffer);
    if (made != kCVReturnSuccess) {
        return made;
    }
    CVReturn locked = CVPixelBufferLockBaseAddress(buffer, 0);
    if (locked != kCVReturnSuccess) {
        CVPixelBufferRelease(buffer);
        return locked;
    }
    int w = self->width, h = self->height;
    uint8_t *y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0);
    size_t y_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0);
    for (int row = 0; row < h; row++) {
        memcpy(y + row * y_stride, i420 + (size_t)row * w, w);
    }
    const uint8_t *u = i420 + (size_t)w * h;
    const uint8_t *v = u + (size_t)(w / 2) * (h / 2);
    uint8_t *uv = CVPixelBufferGetBaseAddressOfPlane(buffer, 1);
    size_t uv_stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1);
    for (int row = 0; row < h / 2; row++) {
        uint8_t *dst = uv + row * uv_stride;
        const uint8_t *su = u + (size_t)row * (w / 2);
        const uint8_t *sv = v + (size_t)row * (w / 2);
        for (int x = 0; x < w / 2; x++) {
            dst[2 * x] = su[x];
            dst[2 * x + 1] = sv[x];
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    *out = buffer;
    return noErr;
}

/* Offer one picture to the current session. Low-latency rate control skips a
 * frame to pay for a large one (an IDR or a refinement); the same picture then
 * goes in again, stamped later each time, which is normally enough. */
static OSStatus submit(dl_vt_encoder *self, const uint8_t *i420, int force_keyframe, int max_qp) {
    CVPixelBufferRef buffer = NULL;
    OSStatus status = copy_i420(self, i420, &buffer);
    if (status != noErr) {
        return status;
    }
    int refine = max_qp < DL_VT_MOTION_MAX_QP;
    int bitrate_kbps = self->bitrate_kbps;
    if (refine) {
        status = self->low_latency
                     ? set_int(self->session, kVTCompressionPropertyKey_MaxAllowedFrameQP, max_qp)
                     : set_rate(self, self->bitrate_kbps * DL_VT_REFINE_RATE_SCALE);
    }
    CFDictionaryRef options = NULL;
    if (status == noErr && force_keyframe) {
        const void *key = kVTEncodeFrameOptionKey_ForceKeyFrame;
        const void *value = kCFBooleanTrue;
        options = CFDictionaryCreate(NULL, &key, &value, 1, &kCFTypeDictionaryKeyCallBacks,
                                     &kCFTypeDictionaryValueCallBacks);
    }
    int64_t gap = 1;
    for (int attempt = 0; status == noErr && attempt < DL_VT_ATTEMPTS; attempt++, gap *= 2) {
        self->out_size = 0;
        self->out_is_key = 0;
        self->out_ready = 0;
        self->out_status = noErr;
        CMTime pts = CMTimeMake(self->frame_index, self->fps);
        self->frame_index += gap;
        status = VTCompressionSessionEncodeFrame(self->session, buffer, pts, CMTimeMake(1, self->fps),
                                                 options, NULL, NULL);
        if (status == noErr) {
            status = VTCompressionSessionCompleteFrames(self->session, kCMTimeInvalid);
        }
        if (status == noErr) {
            status = self->out_ready ? self->out_status : kVTVideoEncoderMalfunctionErr;
        }
        if (status == DL_VT_DROPPED && attempt + 1 < DL_VT_ATTEMPTS) {
            status = noErr;
        } else {
            break;
        }
    }
    if (refine) {
        OSStatus restored =
            self->low_latency
                ? set_int(self->session, kVTCompressionPropertyKey_MaxAllowedFrameQP,
                          DL_VT_MOTION_MAX_QP)
                : set_rate(self, bitrate_kbps);
        if (status == noErr) {
            status = restored;
        }
    }
    if (options != NULL) {
        CFRelease(options);
    }
    CVPixelBufferRelease(buffer);
    return status;
}

/* Encode one tightly packed I420 frame. With `max_qp` below H.264's 51 the
 * frame is a refinement pass, coded under that ceiling. The access unit is
 * available through dl_vt_out_* until the next call.
 *
 * At a rate too low for the size, low-latency rate control skips frame after
 * frame (1080p at a few hundred kbps); the session needs every frame coded, so
 * it moves to the ordinary real-time mode, which has not been seen to skip
 * at any rate, and this picture becomes the new session's IDR. */
OSStatus dl_vt_encode(dl_vt_encoder *self, const uint8_t *i420, int force_keyframe, int max_qp) {
    if (self->session == NULL) {
        return kVTInvalidSessionErr; /* a failed fallback reopen */
    }
    OSStatus status = submit(self, i420, force_keyframe, max_qp);
    if (status == DL_VT_DROPPED && self->low_latency) {
        close_session(self);
        status = open_session(self, 0, self->bitrate_kbps);
        if (status == noErr) {
            status = submit(self, i420, 1, max_qp);
        }
    }
    return status;
}

OSStatus dl_vt_set_bitrate(dl_vt_encoder *self, int bitrate_kbps) {
    if (self->session == NULL) {
        return kVTInvalidSessionErr;
    }
    return bitrate_kbps > 0 ? set_rate(self, bitrate_kbps) : kVTParameterErr;
}

const uint8_t *dl_vt_out_data(const dl_vt_encoder *self) { return self->out; }

size_t dl_vt_out_size(const dl_vt_encoder *self) { return self->out_size; }

int dl_vt_out_is_key(const dl_vt_encoder *self) { return self->out_is_key; }
