/*
 * Thin C surface over VA-API's H.264 slice encoder.
 *
 * libva is loaded with dlopen, never linked: a machine without it, or without
 * a GPU that encodes, must still start the engine. The vendored libva headers
 * (MIT, vendor/libva) give the parameter structs their exact layout and the
 * function pointers their exact types; the Rust side sees an opaque handle and
 * a byte slice.
 *
 * The SPS, PPS and slice headers are written here and handed to the driver as
 * packed headers wherever it takes them: some drivers (Mesa's among them)
 * write no header of their own without them, and the SPS carries a VUI that
 * tells the decoder nothing is reordered, so it shows each frame as soon as it
 * is decoded. The stream is Constrained Baseline: CAVLC, no 8x8 transform, P frames against the one
 * previous picture, picture order equal to decode order (POC type 2) so a
 * decoder never holds a frame back.
 */

#include <dlfcn.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <va/va.h>
#include <va/va_drm.h>

/* The quantizer ceiling while the desktop moves; refinement lowers it. */
#define DL_VA_MOTION_MAX_QP 51

#define DL_VA_FUNCTIONS(F)                                                         \
    F(vaInitialize) F(vaTerminate) F(vaSetErrorCallback) F(vaSetInfoCallback)      \
    F(vaErrorStr) F(vaQueryConfigEntrypoints) F(vaGetConfigAttributes)             \
    F(vaCreateConfig) F(vaDestroyConfig) F(vaCreateSurfaces) F(vaDestroySurfaces)  \
    F(vaCreateContext) F(vaDestroyContext) F(vaCreateBuffer) F(vaDestroyBuffer)    \
    F(vaMapBuffer) F(vaUnmapBuffer) F(vaCreateImage) F(vaDestroyImage)             \
    F(vaPutImage) F(vaBeginPicture) F(vaRenderPicture) F(vaEndPicture)            \
    F(vaSyncSurface)

static struct {
#define DL_VA_POINTER(name) __typeof__(name) *name;
    DL_VA_FUNCTIONS(DL_VA_POINTER)
    __typeof__(vaGetDisplayDRM) *vaGetDisplayDRM;
    const char *missing;
} va;

static pthread_once_t va_once = PTHREAD_ONCE_INIT;

/* Resolve libva once per process. The libraries stay loaded: a driver that
 * registered exit handlers must not be unmapped under them. */
static void va_load(void) {
    void *core = dlopen("libva.so.2", RTLD_NOW | RTLD_LOCAL);
    void *drm = dlopen("libva-drm.so.2", RTLD_NOW | RTLD_LOCAL);
    if (core == NULL || drm == NULL) {
        va.missing = "libva.so.2 or libva-drm.so.2 is not installed";
        return;
    }
#define DL_VA_RESOLVE(name)                                    \
    if ((va.name = (__typeof__(name) *)dlsym(core, #name)) == NULL) \
        va.missing = "libva lacks " #name;
    DL_VA_FUNCTIONS(DL_VA_RESOLVE)
    va.vaGetDisplayDRM = (__typeof__(vaGetDisplayDRM) *)dlsym(drm, "vaGetDisplayDRM");
    if (va.vaGetDisplayDRM == NULL) {
        va.missing = "libva-drm lacks vaGetDisplayDRM";
    }
}

/* libva's default info callback writes to stdout, the engine's protocol
 * channel; failures are reported through the error string instead. */
static void va_quiet(void *context, const char *message) {
    (void)context;
    (void)message;
}

typedef struct {
    int fd;
    VADisplay dpy;
    VAConfigID config;
    VAContextID context;
    /* [0] is the input picture, [1] and [2] alternate as reconstruction and
     * reference. */
    VASurfaceID surfaces[3];
    int surface_count;
    VAImage image;
    int has_image;
    VABufferID coded;
    int width;
    int height;
    int width_mbs;
    int height_mbs;
    int fps;
    int bitrate_kbps;
    unsigned int rc_mode;
    int level_idc;
    /* Frames since the last IDR; 0 means the next frame must be one. */
    unsigned int since_idr;
    unsigned int idr_id;
    int recon;
    /* The rate-control buffers go out again on the next frame. */
    int rc_dirty;
    int last_max_qp;
    uint8_t *packet;
    size_t packet_size;
    size_t packet_capacity;
    int packet_is_key;
    /* The driver takes SPS, PPS and slice headers packed; otherwise it
     * writes its own. */
    int packed_headers;
} dl_vaapi_encoder;

/* An RBSP bit writer; fixed room for an SPS or PPS. */
typedef struct {
    uint8_t data[64];
    int bits;
} bits_t;

static void put(bits_t *b, uint32_t value, int count) {
    for (int i = count - 1; i >= 0; i--, b->bits++) {
        if (value >> i & 1) {
            b->data[b->bits / 8] |= (uint8_t)(0x80 >> (b->bits % 8));
        }
    }
}

static void put_ue(bits_t *b, uint32_t value) {
    int length = 0;
    while ((value + 1) >> (length + 1)) {
        length++;
    }
    put(b, 0, length);
    put(b, value + 1, length + 1);
}

static void put_se(bits_t *b, int32_t value) {
    put_ue(b, value > 0 ? 2 * (uint32_t)value - 1 : 2 * (uint32_t)-value);
}

static void put_trailing(bits_t *b) {
    put(b, 1, 1);
    b->bits = (b->bits + 7) & ~7;
}

/* Start code, then the RBSP with emulation prevention bytes; a slice header's
 * last byte may be partial. */
static size_t to_annexb(const bits_t *b, uint8_t *out) {
    size_t n = 0;
    int zeros = 0;
    out[n++] = 0, out[n++] = 0, out[n++] = 0, out[n++] = 1;
    for (int i = 0; i < (b->bits + 7) / 8; i++) {
        if (zeros >= 2 && b->data[i] <= 3) {
            out[n++] = 3;
            zeros = 0;
        }
        zeros = b->data[i] == 0 ? zeros + 1 : 0;
        out[n++] = b->data[i];
    }
    return n;
}

static void fail(char *error, size_t error_size, const char *format, ...) {
    va_list args;
    va_start(args, format);
    vsnprintf(error, error_size, format, args);
    va_end(args);
}

void dl_vaapi_destroy(dl_vaapi_encoder *self);

/* The smallest level whose frame size and macroblock rate hold this stream,
 * capped at 5.2 as the SDP offer is. */
static int level_for(int mbs, int fps) {
    static const struct { int idc, frame_mbs, mbs_per_second; } levels[] = {
        {30, 1620, 40500},     {31, 3600, 108000},    {32, 5120, 216000},
        {40, 8192, 245760},    {42, 8704, 522240},    {50, 22080, 589824},
        {51, 36864, 983040},
    };
    for (size_t i = 0; i < sizeof levels / sizeof levels[0]; i++) {
        if (mbs <= levels[i].frame_mbs && mbs * fps <= levels[i].mbs_per_second) {
            return levels[i].idc;
        }
    }
    return 52;
}

/* Open an encoder on one DRM render node. Returns NULL with a reason in
 * `error` when the node has no H.264 encoder or refuses this configuration. */
dl_vaapi_encoder *dl_vaapi_create(const char *device, int width, int height, int bitrate_kbps,
                                  int fps, char *error, size_t error_size) {
    pthread_once(&va_once, va_load);
    if (va.missing != NULL) {
        fail(error, error_size, "%s", va.missing);
        return NULL;
    }
    if (width <= 0 || height <= 0 || (width | height) & 1 || bitrate_kbps <= 0 || fps <= 0) {
        fail(error, error_size, "bad geometry %dx%d", width, height);
        return NULL;
    }
    dl_vaapi_encoder *self = calloc(1, sizeof *self);
    if (self == NULL) {
        fail(error, error_size, "out of memory");
        return NULL;
    }
    self->config = VA_INVALID_ID;
    self->context = VA_INVALID_ID;
    self->coded = VA_INVALID_ID;
    self->fd = open(device, O_RDWR | O_CLOEXEC);
    if (self->fd < 0) {
        fail(error, error_size, "cannot open %s", device);
        free(self);
        return NULL;
    }
    self->dpy = va.vaGetDisplayDRM(self->fd);
    if (self->dpy == NULL) {
        fail(error, error_size, "no VA display on %s", device);
        dl_vaapi_destroy(self);
        return NULL;
    }
    va.vaSetInfoCallback(self->dpy, va_quiet, NULL);
    va.vaSetErrorCallback(self->dpy, va_quiet, NULL);
    int major, minor;
    VAStatus status = va.vaInitialize(self->dpy, &major, &minor);
    if (status != VA_STATUS_SUCCESS) {
        fail(error, error_size, "%s: vaInitialize: %s", device, va.vaErrorStr(status));
        va.vaTerminate(self->dpy); /* frees the display a failed init leaves */
        self->dpy = NULL;
        dl_vaapi_destroy(self);
        return NULL;
    }

    int count = 0;
    VAEntrypoint entrypoints[32];
    VAEntrypoint entrypoint = 0;
    const VAProfile profile = VAProfileH264ConstrainedBaseline;
    if (va.vaQueryConfigEntrypoints(self->dpy, profile, entrypoints, &count) == VA_STATUS_SUCCESS) {
        for (int i = 0; i < count && i < 32; i++) {
            if (entrypoints[i] == VAEntrypointEncSlice ||
                (entrypoints[i] == VAEntrypointEncSliceLP && entrypoint == 0)) {
                entrypoint = entrypoints[i];
            }
        }
    }
    if (entrypoint == 0) {
        fail(error, error_size, "%s: no H.264 Constrained Baseline encoder", device);
        dl_vaapi_destroy(self);
        return NULL;
    }
    VAConfigAttrib attributes[3] = {{VAConfigAttribRTFormat, 0},
                                    {VAConfigAttribRateControl, 0},
                                    {VAConfigAttribEncPackedHeaders, 0}};
    va.vaGetConfigAttributes(self->dpy, profile, entrypoint, attributes, 3);
    const unsigned int packed =
        VA_ENC_PACKED_HEADER_SEQUENCE | VA_ENC_PACKED_HEADER_PICTURE | VA_ENC_PACKED_HEADER_SLICE;
    self->packed_headers = attributes[2].value != VA_ATTRIB_NOT_SUPPORTED &&
                           (attributes[2].value & packed) == packed;
    if (attributes[0].value == VA_ATTRIB_NOT_SUPPORTED || !(attributes[0].value & VA_RT_FORMAT_YUV420)) {
        fail(error, error_size, "%s: the H.264 encoder takes no 4:2:0 input", device);
        dl_vaapi_destroy(self);
        return NULL;
    }
    unsigned int rc = attributes[1].value == VA_ATTRIB_NOT_SUPPORTED ? 0 : attributes[1].value;
    self->rc_mode = rc & VA_RC_CBR ? VA_RC_CBR : rc & VA_RC_VBR ? VA_RC_VBR : 0;
    if (self->rc_mode == 0) {
        fail(error, error_size, "%s: the H.264 encoder has neither CBR nor VBR", device);
        dl_vaapi_destroy(self);
        return NULL;
    }
    VAConfigAttrib chosen[3] = {{VAConfigAttribRTFormat, VA_RT_FORMAT_YUV420},
                                {VAConfigAttribRateControl, self->rc_mode},
                                {VAConfigAttribEncPackedHeaders, packed}};
    status = va.vaCreateConfig(self->dpy, profile, entrypoint, chosen,
                               self->packed_headers ? 3 : 2, &self->config);
    if (status != VA_STATUS_SUCCESS) {
        fail(error, error_size, "%s: vaCreateConfig: %s", device, va.vaErrorStr(status));
        dl_vaapi_destroy(self);
        return NULL;
    }

    self->width = width;
    self->height = height;
    self->width_mbs = (width + 15) / 16;
    self->height_mbs = (height + 15) / 16;
    /* The input is the picture's own size; the driver pads it. The
     * reconstructions are macroblock-aligned, as the coded picture is. */
    status = va.vaCreateSurfaces(self->dpy, VA_RT_FORMAT_YUV420, width, height, &self->surfaces[0], 1,
                                 NULL, 0);
    if (status == VA_STATUS_SUCCESS) {
        self->surface_count = 1;
        status = va.vaCreateSurfaces(self->dpy, VA_RT_FORMAT_YUV420, self->width_mbs * 16,
                                     self->height_mbs * 16, &self->surfaces[1], 2, NULL, 0);
    }
    if (status != VA_STATUS_SUCCESS) {
        fail(error, error_size, "%s: vaCreateSurfaces: %s", device, va.vaErrorStr(status));
        dl_vaapi_destroy(self);
        return NULL;
    }
    self->surface_count = 3;
    status = va.vaCreateContext(self->dpy, self->config, self->width_mbs * 16, self->height_mbs * 16,
                                VA_PROGRESSIVE, self->surfaces, 3, &self->context);
    if (status != VA_STATUS_SUCCESS) {
        self->context = VA_INVALID_ID;
        fail(error, error_size, "%s: vaCreateContext %dx%d: %s", device, width, height,
             va.vaErrorStr(status));
        dl_vaapi_destroy(self);
        return NULL;
    }
    VAImageFormat nv12 = {.fourcc = VA_FOURCC_NV12, .byte_order = VA_LSB_FIRST, .bits_per_pixel = 12};
    status = va.vaCreateImage(self->dpy, &nv12, width, height, &self->image);
    if (status != VA_STATUS_SUCCESS) {
        fail(error, error_size, "%s: vaCreateImage NV12: %s", device, va.vaErrorStr(status));
        dl_vaapi_destroy(self);
        return NULL;
    }
    self->has_image = 1;
    /* Twice the raw picture: more than any frame, even an I_PCM one, needs. */
    unsigned int coded_size = (unsigned int)self->width_mbs * self->height_mbs * 256 * 3;
    status = va.vaCreateBuffer(self->dpy, self->context, VAEncCodedBufferType, coded_size, 1, NULL,
                               &self->coded);
    if (status != VA_STATUS_SUCCESS) {
        self->coded = VA_INVALID_ID;
        fail(error, error_size, "%s: coded buffer: %s", device, va.vaErrorStr(status));
        dl_vaapi_destroy(self);
        return NULL;
    }
    self->fps = fps;
    self->bitrate_kbps = bitrate_kbps;
    self->level_idc = level_for(self->width_mbs * self->height_mbs, fps);
    self->recon = 1;
    self->rc_dirty = 1;
    self->last_max_qp = DL_VA_MOTION_MAX_QP;
    return self;
}

/* Copy tightly packed I420 into the NV12 image and onto the input surface. */
static int upload(dl_vaapi_encoder *self, const uint8_t *i420) {
    uint8_t *base;
    if (va.vaMapBuffer(self->dpy, self->image.buf, (void **)&base) != VA_STATUS_SUCCESS) {
        return -1;
    }
    int w = self->width, h = self->height;
    for (int y = 0; y < h; y++) {
        memcpy(base + self->image.offsets[0] + (size_t)y * self->image.pitches[0],
               i420 + (size_t)y * w, (size_t)w);
    }
    const uint8_t *u = i420 + (size_t)w * h;
    const uint8_t *v = u + (size_t)(w / 2) * (h / 2);
    for (int y = 0; y < h / 2; y++) {
        uint8_t *row = base + self->image.offsets[1] + (size_t)y * self->image.pitches[1];
        const uint8_t *ur = u + (size_t)y * (w / 2), *vr = v + (size_t)y * (w / 2);
        for (int x = 0; x < w / 2; x++) {
            row[2 * x] = ur[x];
            row[2 * x + 1] = vr[x];
        }
    }
    if (va.vaUnmapBuffer(self->dpy, self->image.buf) != VA_STATUS_SUCCESS) {
        return -1;
    }
    return va.vaPutImage(self->dpy, self->surfaces[0], self->image.image_id, 0, 0, w, h, 0, 0, w, h) ==
                   VA_STATUS_SUCCESS
               ? 0
               : -1;
}

static int add_buffer(dl_vaapi_encoder *self, VABufferID *ids, int *n, VABufferType type,
                      const void *data, size_t size) {
    if (va.vaCreateBuffer(self->dpy, self->context, type, (unsigned int)size, 1, (void *)data,
                          &ids[*n]) != VA_STATUS_SUCCESS) {
        return -1;
    }
    (*n)++;
    return 0;
}

static int add_misc(dl_vaapi_encoder *self, VABufferID *ids, int *n, VAEncMiscParameterType type,
                    const void *payload, size_t size) {
    _Alignas(8) unsigned char buffer[sizeof(VAEncMiscParameterBuffer) + 512];
    VAEncMiscParameterBuffer *misc = (VAEncMiscParameterBuffer *)buffer;
    memset(buffer, 0, sizeof buffer);
    misc->type = type;
    memcpy(misc->data, payload, size);
    return add_buffer(self, ids, n, VAEncMiscParameterBufferType, buffer,
                      sizeof(VAEncMiscParameterBuffer) + size);
}

static int add_packed(dl_vaapi_encoder *self, VABufferID *ids, int *n, uint32_t type,
                      const bits_t *unit) {
    uint8_t data[4 + sizeof unit->data * 3 / 2];
    size_t size = to_annexb(unit, data);
    VAEncPackedHeaderParameterBuffer header = {
        .type = type,
        .bit_length = (uint32_t)(size * 8 - (8 - unit->bits % 8) % 8),
        .has_emulation_bytes = 1};
    return add_buffer(self, ids, n, VAEncPackedHeaderParameterBufferType, &header, sizeof header) ||
           add_buffer(self, ids, n, VAEncPackedHeaderDataBufferType, data, size);
}

/* The slice header for the parameters dl_vaapi_encode gives the driver. */
static int add_slice_header(dl_vaapi_encoder *self, VABufferID *ids, int *n, int idr,
                            unsigned int frame_num, int qp_delta) {
    bits_t slice = {{0}, 0};
    put(&slice, idr ? 0x65 : 0x61, 8); /* nal_ref_idc 3, IDR or non-IDR slice */
    put_ue(&slice, 0);                 /* first_mb_in_slice */
    put_ue(&slice, idr ? 7 : 5);       /* I or P, every slice of the picture */
    put_ue(&slice, 0);                 /* pic_parameter_set_id */
    put(&slice, frame_num, 8);
    if (idr) {
        put_ue(&slice, self->idr_id);
    } else {
        put(&slice, 0, 1); /* num_ref_idx_active_override_flag */
        put(&slice, 0, 1); /* ref_pic_list_modification_flag_l0 */
    }
    put(&slice, 0, idr ? 2 : 1); /* no_output_of_prior_pics, long_term_reference
                                  * or adaptive_ref_pic_marking_mode_flag */
    put_se(&slice, qp_delta);    /* slice_qp_delta */
    put_ue(&slice, 0);           /* disable_deblocking_filter_idc */
    put_ue(&slice, 0);           /* slice_alpha_c0_offset_div2 */
    put_ue(&slice, 0);           /* slice_beta_offset_div2 */
    return add_packed(self, ids, n, VAEncPackedHeaderSlice, &slice);
}

/* SPS and PPS for the parameters dl_vaapi_encode gives the driver. */
static int add_headers(dl_vaapi_encoder *self, VABufferID *ids, int *n) {
    bits_t sps = {{0}, 0}, pps = {{0}, 0};
    put(&sps, 0x67, 8);         /* nal_ref_idc 3, SPS */
    put(&sps, 66, 8);           /* Baseline ... */
    put(&sps, 0xc0, 8);         /* ... constrained (constraint_set0 and set1) */
    put(&sps, self->level_idc, 8);
    put_ue(&sps, 0);            /* seq_parameter_set_id */
    put_ue(&sps, 4);            /* log2_max_frame_num_minus4 */
    put_ue(&sps, 2);            /* pic_order_cnt_type */
    put_ue(&sps, 1);            /* max_num_ref_frames */
    put(&sps, 0, 1);            /* gaps_in_frame_num_value_allowed_flag */
    put_ue(&sps, self->width_mbs - 1);
    put_ue(&sps, self->height_mbs - 1);
    put(&sps, 1, 1);            /* frame_mbs_only_flag */
    put(&sps, 1, 1);            /* direct_8x8_inference_flag */
    int crop_right = (self->width_mbs * 16 - self->width) / 2;
    int crop_bottom = (self->height_mbs * 16 - self->height) / 2;
    put(&sps, crop_right || crop_bottom, 1);
    if (crop_right || crop_bottom) {
        put_ue(&sps, 0);
        put_ue(&sps, crop_right);
        put_ue(&sps, 0);
        put_ue(&sps, crop_bottom);
    }
    put(&sps, 1, 1);            /* vui_parameters_present_flag */
    put(&sps, 0, 1);            /* aspect_ratio_info_present_flag */
    put(&sps, 0, 1);            /* overscan_info_present_flag */
    put(&sps, 1, 1);            /* video_signal_type_present_flag */
    put(&sps, 5, 3);            /* video_format: unspecified */
    put(&sps, 0, 1);            /* limited range, as convert.rs produces */
    put(&sps, 1, 1);            /* colour_description_present_flag */
    put(&sps, 6, 8);            /* BT.601 primaries, transfer and matrix */
    put(&sps, 6, 8);
    put(&sps, 6, 8);
    put(&sps, 0, 1);            /* chroma_loc_info_present_flag */
    put(&sps, 1, 1);            /* timing_info_present_flag */
    put(&sps, 1, 32);           /* num_units_in_tick */
    put(&sps, (uint32_t)self->fps * 2, 32); /* time_scale */
    put(&sps, 0, 1);            /* fixed_frame_rate_flag */
    put(&sps, 0, 1);            /* nal_hrd_parameters_present_flag */
    put(&sps, 0, 1);            /* vcl_hrd_parameters_present_flag */
    put(&sps, 0, 1);            /* pic_struct_present_flag */
    put(&sps, 1, 1);            /* bitstream_restriction_flag */
    put(&sps, 1, 1);            /* motion_vectors_over_pic_boundaries_flag */
    put_ue(&sps, 0);            /* max_bytes_per_pic_denom */
    put_ue(&sps, 0);            /* max_bits_per_mb_denom */
    put_ue(&sps, 16);           /* log2_max_mv_length_horizontal */
    put_ue(&sps, 16);           /* log2_max_mv_length_vertical */
    put_ue(&sps, 0);            /* max_num_reorder_frames: show on decode */
    put_ue(&sps, 1);            /* max_dec_frame_buffering */
    put_trailing(&sps);

    put(&pps, 0x68, 8);         /* nal_ref_idc 3, PPS */
    put_ue(&pps, 0);            /* pic_parameter_set_id */
    put_ue(&pps, 0);            /* seq_parameter_set_id */
    put(&pps, 0, 1);            /* entropy_coding_mode_flag: CAVLC */
    put(&pps, 0, 1);            /* bottom_field_pic_order_in_frame_present_flag */
    put_ue(&pps, 0);            /* num_slice_groups_minus1 */
    put_ue(&pps, 0);            /* num_ref_idx_l0_default_active_minus1 */
    put_ue(&pps, 0);            /* num_ref_idx_l1_default_active_minus1 */
    put(&pps, 0, 1);            /* weighted_pred_flag */
    put(&pps, 0, 2);            /* weighted_bipred_idc */
    put_ue(&pps, 0);            /* pic_init_qp_minus26 (se 0 == ue 0) */
    put_ue(&pps, 0);            /* pic_init_qs_minus26 */
    put_ue(&pps, 0);            /* chroma_qp_index_offset */
    put(&pps, 1, 1);            /* deblocking_filter_control_present_flag */
    put(&pps, 0, 1);            /* constrained_intra_pred_flag */
    put(&pps, 0, 1);            /* redundant_pic_cnt_present_flag */
    put_trailing(&pps);

    return add_packed(self, ids, n, VAEncPackedHeaderSequence, &sps) ||
           add_packed(self, ids, n, VAEncPackedHeaderPicture, &pps);
}

static void invalidate(VAPictureH264 *picture) {
    picture->picture_id = VA_INVALID_SURFACE;
    picture->flags = VA_PICTURE_H264_INVALID;
}

/* Encode one tightly packed I420 frame. `max_qp` is the quantizer ceiling for
 * this frame alone: the motion ceiling, or a refinement's lower one.
 * Returns 1 when a packet is available through dl_vaapi_packet_*, -1 when the
 * driver refused the frame. */
int dl_vaapi_encode(dl_vaapi_encoder *self, const uint8_t *i420, int force_keyframe, int max_qp) {
    if (self == NULL || i420 == NULL || upload(self, i420) != 0) {
        return -1;
    }
    int idr = force_keyframe || self->since_idr == 0;
    if (idr) {
        self->since_idr = 0;
        self->rc_dirty = 1;
    }
    if (max_qp != self->last_max_qp) {
        self->last_max_qp = max_qp;
        self->rc_dirty = 1;
    }
    VASurfaceID recon = self->surfaces[self->recon];
    VASurfaceID reference = self->surfaces[3 - self->recon];
    VABufferID ids[16];
    int n = 0;
    int failed = 0;

    if (idr) {
        VAEncSequenceParameterBufferH264 seq = {0};
        seq.level_idc = self->level_idc;
        /* Informational for the driver: there is no periodic key frame. The
         * frame types below are what decide. */
        seq.intra_period = seq.intra_idr_period = 0x7fffffff;
        seq.ip_period = 1;
        seq.bits_per_second = (unsigned int)self->bitrate_kbps * 1000;
        seq.max_num_ref_frames = 1;
        seq.picture_width_in_mbs = self->width_mbs;
        seq.picture_height_in_mbs = self->height_mbs;
        seq.seq_fields.bits.chroma_format_idc = 1;
        seq.seq_fields.bits.frame_mbs_only_flag = 1;
        seq.seq_fields.bits.direct_8x8_inference_flag = 1;
        seq.seq_fields.bits.log2_max_frame_num_minus4 = 4;
        seq.seq_fields.bits.pic_order_cnt_type = 2;
        int crop_right = self->width_mbs * 16 - self->width;
        int crop_bottom = self->height_mbs * 16 - self->height;
        if (crop_right || crop_bottom) {
            /* In chroma samples: two luma samples per unit at 4:2:0. */
            seq.frame_cropping_flag = 1;
            seq.frame_crop_right_offset = crop_right / 2;
            seq.frame_crop_bottom_offset = crop_bottom / 2;
        }
        seq.vui_parameters_present_flag = 1;
        seq.vui_fields.bits.timing_info_present_flag = 1;
        seq.vui_fields.bits.bitstream_restriction_flag = 1;
        seq.vui_fields.bits.log2_max_mv_length_horizontal = 16;
        seq.vui_fields.bits.log2_max_mv_length_vertical = 16;
        seq.num_units_in_tick = 1;
        seq.time_scale = (unsigned int)self->fps * 2;
        failed |= add_buffer(self, ids, &n, VAEncSequenceParameterBufferType, &seq, sizeof seq);
        if (self->packed_headers) {
            failed |= add_headers(self, ids, &n);
        }
    }
    if (self->rc_dirty) {
        VAEncMiscParameterRateControl rate = {0};
        rate.bits_per_second = (unsigned int)self->bitrate_kbps * 1000;
        rate.target_percentage = self->rc_mode == VA_RC_CBR ? 100 : 90;
        rate.window_size = 1000;
        rate.initial_qp = 26;
        rate.min_qp = 1;
        rate.max_qp = (unsigned int)max_qp;
        /* A skipped frame is a frozen desktop until the next change. */
        rate.rc_flags.bits.disable_frame_skip = 1;
        failed |= add_misc(self, ids, &n, VAEncMiscParameterTypeRateControl, &rate, sizeof rate);
        VAEncMiscParameterFrameRate rate_fps = {.framerate = (unsigned int)self->fps};
        failed |= add_misc(self, ids, &n, VAEncMiscParameterTypeFrameRate, &rate_fps, sizeof rate_fps);
        /* One second of buffer, half full: a key frame may borrow several
         * frames' budget. */
        VAEncMiscParameterHRD hrd = {.buffer_size = (unsigned int)self->bitrate_kbps * 1000,
                                     .initial_buffer_fullness = (unsigned int)self->bitrate_kbps * 500};
        failed |= add_misc(self, ids, &n, VAEncMiscParameterTypeHRD, &hrd, sizeof hrd);
    }

    VAEncPictureParameterBufferH264 pic = {0};
    unsigned int frame_num = self->since_idr & 0xff;
    pic.CurrPic.picture_id = recon;
    pic.CurrPic.frame_idx = frame_num;
    pic.CurrPic.TopFieldOrderCnt = (int32_t)(self->since_idr * 2);
    pic.CurrPic.BottomFieldOrderCnt = pic.CurrPic.TopFieldOrderCnt;
    for (int i = 0; i < 16; i++) {
        invalidate(&pic.ReferenceFrames[i]);
    }
    VAPictureH264 ref = {0};
    if (!idr) {
        ref.picture_id = reference;
        ref.frame_idx = (self->since_idr - 1) & 0xff;
        ref.flags = VA_PICTURE_H264_SHORT_TERM_REFERENCE;
        ref.TopFieldOrderCnt = (int32_t)((self->since_idr - 1) * 2);
        ref.BottomFieldOrderCnt = ref.TopFieldOrderCnt;
        pic.ReferenceFrames[0] = ref;
    }
    pic.coded_buf = self->coded;
    pic.frame_num = frame_num;
    pic.pic_init_qp = 26;
    pic.pic_fields.bits.idr_pic_flag = idr;
    pic.pic_fields.bits.reference_pic_flag = 1;
    pic.pic_fields.bits.deblocking_filter_control_present_flag = 1;
    failed |= add_buffer(self, ids, &n, VAEncPictureParameterBufferType, &pic, sizeof pic);

    VAEncSliceParameterBufferH264 slice = {0};
    /* A lowered ceiling also starts the frame at it. Under rate control this
     * is only a hint, but Mesa sends a frame's QP limits to the encoder only
     * when its starting QP changes: without it the ceiling would not move. */
    slice.slice_qp_delta = max_qp < DL_VA_MOTION_MAX_QP ? max_qp - 26 : 0;
    slice.num_macroblocks = self->width_mbs * self->height_mbs;
    slice.slice_type = idr ? 2 : 0; /* I : P */
    slice.idr_pic_id = self->idr_id;
    for (int i = 0; i < 32; i++) {
        invalidate(&slice.RefPicList0[i]);
        invalidate(&slice.RefPicList1[i]);
    }
    if (!idr) {
        slice.RefPicList0[0] = ref;
    }
    failed |= add_buffer(self, ids, &n, VAEncSliceParameterBufferType, &slice, sizeof slice);
    if (self->packed_headers) {
        failed |= add_slice_header(self, ids, &n, idr, frame_num, slice.slice_qp_delta);
    }

    if (!failed) {
        failed = va.vaBeginPicture(self->dpy, self->context, self->surfaces[0]) != VA_STATUS_SUCCESS;
        if (!failed) {
            failed |= va.vaRenderPicture(self->dpy, self->context, ids, n) != VA_STATUS_SUCCESS;
            /* EndPicture always, so a refused render leaves no picture open. */
            failed |= va.vaEndPicture(self->dpy, self->context) != VA_STATUS_SUCCESS;
        }
    }
    for (int i = 0; i < n; i++) {
        va.vaDestroyBuffer(self->dpy, ids[i]);
    }
    if (failed || va.vaSyncSurface(self->dpy, self->surfaces[0]) != VA_STATUS_SUCCESS) {
        self->since_idr = 0; /* the reference is unknown now */
        return -1;
    }

    VACodedBufferSegment *segment;
    if (va.vaMapBuffer(self->dpy, self->coded, (void **)&segment) != VA_STATUS_SUCCESS) {
        self->since_idr = 0;
        return -1;
    }
    self->packet_size = 0;
    for (VACodedBufferSegment *s = segment; s != NULL; s = (VACodedBufferSegment *)s->next) {
        if (self->packet_size + s->size > self->packet_capacity) {
            size_t capacity = (self->packet_size + s->size) * 2;
            uint8_t *grown = realloc(self->packet, capacity);
            if (grown == NULL) {
                va.vaUnmapBuffer(self->dpy, self->coded);
                return -1;
            }
            self->packet = grown;
            self->packet_capacity = capacity;
        }
        memcpy(self->packet + self->packet_size, s->buf, s->size);
        self->packet_size += s->size;
    }
    va.vaUnmapBuffer(self->dpy, self->coded);

    if (idr) {
        self->idr_id = (self->idr_id + 1) & 0xffff;
    }
    self->packet_is_key = idr;
    self->since_idr++;
    self->recon = 3 - self->recon;
    self->rc_dirty = 0;
    return self->packet_size > 0 ? 1 : -1;
}

/* The target for the frames that follow; never forces an IDR. */
void dl_vaapi_set_bitrate(dl_vaapi_encoder *self, int bitrate_kbps) {
    if (bitrate_kbps > 0 && bitrate_kbps != self->bitrate_kbps) {
        self->bitrate_kbps = bitrate_kbps;
        self->rc_dirty = 1;
    }
}

int dl_vaapi_motion_max_qp(void) { return DL_VA_MOTION_MAX_QP; }

const uint8_t *dl_vaapi_packet_data(const dl_vaapi_encoder *self) { return self->packet; }

size_t dl_vaapi_packet_size(const dl_vaapi_encoder *self) { return self->packet_size; }

int dl_vaapi_packet_is_key(const dl_vaapi_encoder *self) { return self->packet_is_key; }

void dl_vaapi_destroy(dl_vaapi_encoder *self) {
    if (self == NULL) {
        return;
    }
    if (self->dpy != NULL) {
        if (self->coded != VA_INVALID_ID) {
            va.vaDestroyBuffer(self->dpy, self->coded);
        }
        if (self->has_image) {
            va.vaDestroyImage(self->dpy, self->image.image_id);
        }
        if (self->context != VA_INVALID_ID) {
            va.vaDestroyContext(self->dpy, self->context);
        }
        if (self->surface_count > 0) {
            va.vaDestroySurfaces(self->dpy, self->surfaces, self->surface_count);
        }
        if (self->config != VA_INVALID_ID) {
            va.vaDestroyConfig(self->dpy, self->config);
        }
        va.vaTerminate(self->dpy);
    }
    if (self->fd >= 0) {
        close(self->fd);
    }
    free(self->packet);
    free(self);
}
