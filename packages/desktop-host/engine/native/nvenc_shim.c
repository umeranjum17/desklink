/*
 * Thin C surface over NVIDIA's NVENC H.264 encoder.
 *
 * NVENC is configured through large versioned structs from nvEncodeAPI.h;
 * doing that configuration in C, where the compiler and the header agree,
 * keeps a wrong offset from producing a broken stream. The Rust side sees an
 * opaque handle and a byte slice.
 *
 * Nothing is linked: libcuda and libnvidia-encode ship with the NVIDIA driver,
 * so both are opened with dlopen when an encoder is created, and a machine
 * without them only gets an error back. The header is nv-codec-headers' copy
 * of the Video Codec SDK 10.0 API (MIT, vendored under vendor/), the oldest
 * with the P1-P7 presets and tuning info; any Linux driver from 450.51 on
 * accepts it.
 */

#include <dlfcn.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <ffnvcodec/nvEncodeAPI.h>

/* The CUDA driver API calls used here, declared rather than included: the
 * five signatures are stable ABI, and the SDK header is not redistributable. */
typedef int CUresult;
typedef int CUdevice;
typedef void *CUcontext;

typedef struct {
    CUcontext cuda;
    CUresult (*cu_ctx_push)(CUcontext);
    CUresult (*cu_ctx_pop)(CUcontext *);
    CUresult (*cu_primary_release)(CUdevice);
    CUdevice device;
    NV_ENCODE_API_FUNCTION_LIST api;
    void *session;
    NV_ENC_INITIALIZE_PARAMS init;
    NV_ENC_CONFIG config;
    NV_ENC_INPUT_PTR input;
    NV_ENC_OUTPUT_PTR output;
    int width;
    int height;
    uint64_t frame_index;
    /* The last access unit, copied out so the bitstream buffer can be unlocked
     * before encode returns. */
    uint8_t *packet;
    size_t packet_size;
    size_t packet_capacity;
    int packet_is_key;
    char error[256];
} dl_nvenc_encoder;

static void fail(char *error, size_t len, const char *fmt, ...) {
    if (error == NULL || len == 0) {
        return;
    }
    va_list args;
    va_start(args, fmt);
    vsnprintf(error, len, fmt, args);
    va_end(args);
}

static const char *nvenc_reason(dl_nvenc_encoder *self) {
    const char *text = NULL;
    if (self->session != NULL && self->api.nvEncGetLastErrorString != NULL) {
        text = self->api.nvEncGetLastErrorString(self->session);
    }
    return text != NULL && text[0] != '\0' ? text : "no detail from the driver";
}

static void destroy(dl_nvenc_encoder *self);

/* Rate control for `bitrate_kbps`, with a quantizer ceiling when `max_qp` > 0.
 * CBR with a one-second buffer, like the VP9 path: a single-frame buffer
 * would starve every IDR, and a desktop's IDRs are rare and must be legible. */
static void set_rate(dl_nvenc_encoder *self, int bitrate_kbps, int max_qp) {
    NV_ENC_RC_PARAMS *rc = &self->config.rcParams;
    uint32_t bits = (uint32_t)bitrate_kbps * 1000u;
    rc->rateControlMode = NV_ENC_PARAMS_RC_CBR;
    rc->averageBitRate = bits;
    rc->maxBitRate = bits;
    rc->vbvBufferSize = bits;
    rc->vbvInitialDelay = bits / 2;
    /* The ceiling stays enabled and is lifted by raising it to 51: the 610
     * driver ignores enableMaxQP going back to 0 and keeps the last cap. */
    rc->enableMaxQP = 1;
    rc->maxQP.qpInterP = rc->maxQP.qpInterB = rc->maxQP.qpIntra =
        max_qp > 0 ? (uint32_t)max_qp : 51;
}

/* Opening and closing sessions is serialized process-wide. With two sessions
 * set up or torn down at the same time, the 610 driver was seen to fault later
 * in one of its worker threads in about half of the runs. Serialized, a probe
 * beside a running stream (the engine's case: one session at a time, one
 * cached probe) did not fault in 35 runs; several threads churning sessions
 * at once still faulted in a few runs in 25, so this narrows a driver bug the
 * engine does not otherwise reach rather than fixing it. */
static pthread_mutex_t lifecycle = PTHREAD_MUTEX_INITIALIZER;

static dl_nvenc_encoder *create(int width, int height, int bitrate_kbps, int fps,
                                char *error, size_t error_len) {
    if (width <= 0 || height <= 0 || (width | height) & 1 || bitrate_kbps <= 0 || fps <= 0) {
        fail(error, error_len, "invalid geometry or rate");
        return NULL;
    }
    dl_nvenc_encoder *self = calloc(1, sizeof(dl_nvenc_encoder));
    if (self == NULL) {
        fail(error, error_len, "out of memory");
        return NULL;
    }
    self->width = width;
    self->height = height;

    void *cuda_lib = dlopen("libcuda.so.1", RTLD_NOW | RTLD_LOCAL);
    if (cuda_lib == NULL) {
        fail(error, error_len, "libcuda.so.1 not found (no NVIDIA driver)");
        goto failed;
    }
    CUresult (*cu_init)(unsigned) = (CUresult(*)(unsigned))dlsym(cuda_lib, "cuInit");
    CUresult (*cu_device_get)(CUdevice *, int) =
        (CUresult(*)(CUdevice *, int))dlsym(cuda_lib, "cuDeviceGet");
    CUresult (*cu_primary_retain)(CUcontext *, CUdevice) =
        (CUresult(*)(CUcontext *, CUdevice))dlsym(cuda_lib, "cuDevicePrimaryCtxRetain");
    self->cu_ctx_push = (CUresult(*)(CUcontext))dlsym(cuda_lib, "cuCtxPushCurrent_v2");
    self->cu_ctx_pop = (CUresult(*)(CUcontext *))dlsym(cuda_lib, "cuCtxPopCurrent_v2");
    self->cu_primary_release =
        (CUresult(*)(CUdevice))dlsym(cuda_lib, "cuDevicePrimaryCtxRelease_v2");
    if (!cu_init || !cu_device_get || !cu_primary_retain || !self->cu_ctx_push ||
        !self->cu_ctx_pop || !self->cu_primary_release) {
        fail(error, error_len, "libcuda.so.1 lacks the CUDA driver API");
        goto failed;
    }
    /* The device's primary context, shared by every session in the process,
     * made current around each call since the encoder moves between threads. */
    CUresult cu = cu_init(0);
    if (cu == 0) {
        cu = cu_device_get(&self->device, 0);
    }
    if (cu == 0) {
        cu = cu_primary_retain(&self->cuda, self->device);
    }
    if (cu != 0) {
        self->cuda = NULL;
        fail(error, error_len, "no usable CUDA device (CUDA error %d)", cu);
        goto failed;
    }
    void *enc_lib = dlopen("libnvidia-encode.so.1", RTLD_NOW | RTLD_LOCAL);
    if (enc_lib == NULL) {
        fail(error, error_len, "libnvidia-encode.so.1 not found");
        goto failed;
    }
    NVENCSTATUS (*max_version)(uint32_t *) =
        (NVENCSTATUS(*)(uint32_t *))dlsym(enc_lib, "NvEncodeAPIGetMaxSupportedVersion");
    NVENCSTATUS (*create_instance)(NV_ENCODE_API_FUNCTION_LIST *) =
        (NVENCSTATUS(*)(NV_ENCODE_API_FUNCTION_LIST *))dlsym(enc_lib,
                                                             "NvEncodeAPICreateInstance");
    uint32_t supported = 0;
    if (!max_version || !create_instance || max_version(&supported) != NV_ENC_SUCCESS) {
        fail(error, error_len, "libnvidia-encode.so.1 is not a usable NVENC library");
        goto failed;
    }
    if (supported < ((NVENCAPI_MAJOR_VERSION << 4) | NVENCAPI_MINOR_VERSION)) {
        fail(error, error_len, "the NVIDIA driver supports NVENC API %u.%u; %d.%d is needed",
             supported >> 4, supported & 15, NVENCAPI_MAJOR_VERSION, NVENCAPI_MINOR_VERSION);
        goto failed;
    }
    self->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    if (create_instance(&self->api) != NV_ENC_SUCCESS) {
        fail(error, error_len, "NvEncodeAPICreateInstance failed");
        goto failed;
    }

    if (self->cu_ctx_push(self->cuda) != 0) {
        fail(error, error_len, "the CUDA context could not be made current");
        goto failed;
    }
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {0};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.deviceType = NV_ENC_DEVICE_TYPE_CUDA;
    open.device = self->cuda;
    open.apiVersion = NVENCAPI_VERSION;
    NVENCSTATUS status = self->api.nvEncOpenEncodeSessionEx(&open, &self->session);
    if (status != NV_ENC_SUCCESS) {
        /* Consumer GPUs cap concurrent sessions; this is where that shows. */
        fail(error, error_len, "NVENC refused a session (status %d)", (int)status);
        self->session = NULL;
        goto failed_pushed;
    }

    /* P3 under ultra-low-latency tuning codes 4K60 within a frame interval
     * with room to spare; the higher presets add little on screen content. */
    NV_ENC_PRESET_CONFIG preset = {0};
    preset.version = NV_ENC_PRESET_CONFIG_VER;
    preset.presetCfg.version = NV_ENC_CONFIG_VER;
    status = self->api.nvEncGetEncodePresetConfigEx(self->session, NV_ENC_CODEC_H264_GUID,
                                                    NV_ENC_PRESET_P3_GUID,
                                                    NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset);
    if (status != NV_ENC_SUCCESS) {
        fail(error, error_len, "NVENC has no H.264 preset (status %d): %s", (int)status, nvenc_reason(self));
        goto failed_pushed;
    }
    self->config = preset.presetCfg;
    self->config.version = NV_ENC_CONFIG_VER;
    self->config.profileGUID = NV_ENC_H264_PROFILE_BASELINE_GUID;
    /* IDRs only when asked for; P frames only, so nothing is ever reordered. */
    self->config.gopLength = NVENC_INFINITE_GOPLENGTH;
    self->config.frameIntervalP = 1;
    set_rate(self, bitrate_kbps, 0);
    self->config.rcParams.enableLookahead = 0;
    self->config.rcParams.zeroReorderDelay = 1;
    NV_ENC_CONFIG_H264 *h264 = &self->config.encodeCodecConfig.h264Config;
    h264->idrPeriod = NVENC_INFINITE_GOPLENGTH;
    h264->repeatSPSPPS = 1;
    h264->disableSPSPPS = 0;
    h264->outputAUD = 0;
    h264->enableIntraRefresh = 0;
    h264->sliceMode = 0;
    h264->sliceModeData = 0;
    h264->level = NV_ENC_LEVEL_AUTOSELECT;
    h264->chromaFormatIDC = 1;
    /* Constrained Baseline: CAVLC and no 8x8 transform. */
    h264->entropyCodingMode = NV_ENC_H264_ENTROPY_CODING_MODE_CAVLC;
    h264->adaptiveTransformMode = NV_ENC_H264_ADAPTIVE_TRANSFORM_DISABLE;

    NV_ENC_INITIALIZE_PARAMS *init = &self->init;
    init->version = NV_ENC_INITIALIZE_PARAMS_VER;
    init->encodeGUID = NV_ENC_CODEC_H264_GUID;
    init->presetGUID = NV_ENC_PRESET_P3_GUID;
    init->tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    /* Any even size: NVENC pads to macroblocks and writes the SPS crop. */
    init->encodeWidth = init->darWidth = init->maxEncodeWidth = (uint32_t)width;
    init->encodeHeight = init->darHeight = init->maxEncodeHeight = (uint32_t)height;
    init->frameRateNum = (uint32_t)fps;
    init->frameRateDen = 1;
    init->enablePTD = 1;
    init->enableEncodeAsync = 0;
    init->encodeConfig = &self->config;
    status = self->api.nvEncInitializeEncoder(self->session, init);
    if (status != NV_ENC_SUCCESS) {
        fail(error, error_len, "NVENC refused %dx%d H.264: %s", width, height,
             nvenc_reason(self));
        goto failed_pushed;
    }

    NV_ENC_CREATE_INPUT_BUFFER input = {0};
    input.version = NV_ENC_CREATE_INPUT_BUFFER_VER;
    input.width = (uint32_t)width;
    input.height = (uint32_t)height;
    input.bufferFmt = NV_ENC_BUFFER_FORMAT_IYUV;
    status = self->api.nvEncCreateInputBuffer(self->session, &input);
    if (status != NV_ENC_SUCCESS) {
        fail(error, error_len, "NVENC input buffer (status %d): %s", (int)status, nvenc_reason(self));
        goto failed_pushed;
    }
    self->input = input.inputBuffer;
    NV_ENC_CREATE_BITSTREAM_BUFFER output = {0};
    output.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    status = self->api.nvEncCreateBitstreamBuffer(self->session, &output);
    if (status != NV_ENC_SUCCESS) {
        fail(error, error_len, "NVENC bitstream buffer (status %d): %s", (int)status, nvenc_reason(self));
        goto failed_pushed;
    }
    self->output = output.bitstreamBuffer;
    self->cu_ctx_pop(NULL);
    return self;

failed_pushed:
    self->cu_ctx_pop(NULL);
failed:
    destroy(self);
    return NULL;
}

/* Copy tightly packed I420 into the locked input buffer, whose rows are
 * `pitch` bytes for luma and half that for chroma, planes back to back. */
static int upload(dl_nvenc_encoder *self, const uint8_t *i420) {
    NV_ENC_LOCK_INPUT_BUFFER lock = {0};
    lock.version = NV_ENC_LOCK_INPUT_BUFFER_VER;
    lock.inputBuffer = self->input;
    NVENCSTATUS status = self->api.nvEncLockInputBuffer(self->session, &lock);
    if (status != NV_ENC_SUCCESS) {
        fail(self->error, sizeof self->error, "lock input (status %d): %s", (int)status, nvenc_reason(self));
        return -1;
    }
    int w = self->width, h = self->height;
    size_t pitch = lock.pitch;
    uint8_t *dst = lock.bufferDataPtr;
    for (int y = 0; y < h; y++) {
        memcpy(dst + y * pitch, i420 + (size_t)y * w, (size_t)w);
    }
    const uint8_t *src = i420 + (size_t)w * h;
    dst += pitch * h;
    for (int plane = 0; plane < 2; plane++) {
        for (int y = 0; y < h / 2; y++) {
            memcpy(dst + y * (pitch / 2), src + (size_t)y * (w / 2), (size_t)(w / 2));
        }
        src += (size_t)(w / 2) * (h / 2);
        dst += (pitch / 2) * (h / 2);
    }
    self->api.nvEncUnlockInputBuffer(self->session, self->input);
    return (int)lock.pitch;
}

/* Encode one tightly packed I420 frame at the opened size; the access unit is
 * complete when this returns. Returns 1 with a packet, -1 on failure. */
int dl_nvenc_encode(dl_nvenc_encoder *self, const uint8_t *i420, int force_idr) {
    if (self == NULL || i420 == NULL) {
        return -1;
    }
    if (self->cu_ctx_push(self->cuda) != 0) {
        fail(self->error, sizeof self->error, "the CUDA context could not be made current");
        return -1;
    }
    int result = -1;
    int pitch = upload(self, i420);
    if (pitch < 0) {
        goto done;
    }
    NV_ENC_PIC_PARAMS pic = {0};
    pic.version = NV_ENC_PIC_PARAMS_VER;
    pic.inputWidth = (uint32_t)self->width;
    pic.inputHeight = (uint32_t)self->height;
    pic.inputPitch = (uint32_t)pitch;
    pic.inputBuffer = self->input;
    pic.outputBitstream = self->output;
    pic.bufferFmt = NV_ENC_BUFFER_FORMAT_IYUV;
    pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    pic.inputTimeStamp = self->frame_index++;
    if (force_idr) {
        pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
    }
    NVENCSTATUS status = self->api.nvEncEncodePicture(self->session, &pic);
    if (status != NV_ENC_SUCCESS) {
        fail(self->error, sizeof self->error, "encode (status %d): %s", (int)status, nvenc_reason(self));
        goto done;
    }
    NV_ENC_LOCK_BITSTREAM lock = {0};
    lock.version = NV_ENC_LOCK_BITSTREAM_VER;
    lock.outputBitstream = self->output;
    status = self->api.nvEncLockBitstream(self->session, &lock);
    if (status != NV_ENC_SUCCESS) {
        fail(self->error, sizeof self->error, "lock bitstream (status %d): %s", (int)status, nvenc_reason(self));
        goto done;
    }
    size_t size = lock.bitstreamSizeInBytes;
    if (size > self->packet_capacity) {
        uint8_t *grown = realloc(self->packet, size);
        if (grown == NULL) {
            self->api.nvEncUnlockBitstream(self->session, self->output);
            fail(self->error, sizeof self->error, "out of memory");
            goto done;
        }
        self->packet = grown;
        self->packet_capacity = size;
    }
    memcpy(self->packet, lock.bitstreamBufferPtr, size);
    self->packet_size = size;
    self->packet_is_key = lock.pictureType == NV_ENC_PIC_TYPE_IDR;
    self->api.nvEncUnlockBitstream(self->session, self->output);
    result = size > 0 ? 1 : -1;
    if (size == 0) {
        fail(self->error, sizeof self->error, "empty access unit");
    }
done:
    self->cu_ctx_pop(NULL);
    return result;
}

/* Change the rate target and, with `max_qp` > 0, cap the quantizer, for the
 * frames that follow — in place, without an IDR or a rate-control reset.
 * Returns 0 on success. */
int dl_nvenc_reconfigure(dl_nvenc_encoder *self, int bitrate_kbps, int max_qp) {
    if (self == NULL) {
        return -1;
    }
    if (bitrate_kbps <= 0) {
        fail(self->error, sizeof self->error, "a rate of %d kbps", bitrate_kbps);
        return -1;
    }
    if (self->cu_ctx_push(self->cuda) != 0) {
        fail(self->error, sizeof self->error, "the CUDA context could not be made current");
        return -1;
    }
    set_rate(self, bitrate_kbps, max_qp);
    NV_ENC_RECONFIGURE_PARAMS params = {0};
    params.version = NV_ENC_RECONFIGURE_PARAMS_VER;
    params.reInitEncodeParams = self->init;
    params.resetEncoder = 0;
    params.forceIDR = 0;
    NVENCSTATUS status = self->api.nvEncReconfigureEncoder(self->session, &params);
    self->cu_ctx_pop(NULL);
    if (status != NV_ENC_SUCCESS) {
        fail(self->error, sizeof self->error, "reconfigure (status %d): %s", (int)status, nvenc_reason(self));
        return -1;
    }
    return 0;
}

const uint8_t *dl_nvenc_packet_data(const dl_nvenc_encoder *self) { return self->packet; }

size_t dl_nvenc_packet_size(const dl_nvenc_encoder *self) { return self->packet_size; }

int dl_nvenc_packet_is_key(const dl_nvenc_encoder *self) { return self->packet_is_key; }

const char *dl_nvenc_error(const dl_nvenc_encoder *self) { return self->error; }

static void destroy(dl_nvenc_encoder *self) {
    if (self == NULL) {
        return;
    }
    if (self->session != NULL && self->cu_ctx_push(self->cuda) == 0) {
        if (self->input != NULL) {
            /* End of stream: the encoder is flushed before it is closed. */
            NV_ENC_PIC_PARAMS eos = {0};
            eos.version = NV_ENC_PIC_PARAMS_VER;
            eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
            self->api.nvEncEncodePicture(self->session, &eos);
            self->api.nvEncDestroyInputBuffer(self->session, self->input);
        }
        if (self->output != NULL) {
            self->api.nvEncDestroyBitstreamBuffer(self->session, self->output);
        }
        self->api.nvEncDestroyEncoder(self->session);
        self->cu_ctx_pop(NULL);
    }
    if (self->cuda != NULL) {
        self->cu_primary_release(self->device);
    }
    /* The driver libraries stay loaded (no dlclose): driver worker threads
     * can outlive a session, and the next session skips the load. */
    free(self->packet);
    free(self);
}

/* Returns NULL with the reason in `error` when the driver, the device or the
 * session is unavailable; nothing is left open in that case. */
dl_nvenc_encoder *dl_nvenc_create(int width, int height, int bitrate_kbps, int fps,
                                  char *error, size_t error_len) {
    pthread_mutex_lock(&lifecycle);
    dl_nvenc_encoder *self = create(width, height, bitrate_kbps, fps, error, error_len);
    pthread_mutex_unlock(&lifecycle);
    return self;
}

void dl_nvenc_destroy(dl_nvenc_encoder *self) {
    pthread_mutex_lock(&lifecycle);
    destroy(self);
    pthread_mutex_unlock(&lifecycle);
}
