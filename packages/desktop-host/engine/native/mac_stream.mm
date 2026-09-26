#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreMedia/CoreMedia.h>

using FrameCallback = void (*)(void *, const uint8_t *, size_t, size_t, size_t, size_t);
using StatusCallback = void (*)(void *, const char *, bool);

@interface DLStreamOutput : NSObject <SCStreamOutput>
@property(nonatomic, assign) void *context;
@property(nonatomic, assign) FrameCallback callback;
@end

@implementation DLStreamOutput
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    (void)stream;
    if (type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    @autoreleasepool {
        CVPixelBufferRef pixel = CMSampleBufferGetImageBuffer(sample);
        if (!pixel || CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return;
        const uint8_t *base = (const uint8_t *)CVPixelBufferGetBaseAddress(pixel);
        if (base && CVPixelBufferGetPixelFormatType(pixel) == kCVPixelFormatType_32BGRA)
            self.callback(self.context, base, CVPixelBufferGetDataSize(pixel),
                          CVPixelBufferGetWidth(pixel), CVPixelBufferGetHeight(pixel), CVPixelBufferGetBytesPerRow(pixel));
        CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly);
    }
}
@end

@interface DLStreamSession : NSObject <SCStreamDelegate>
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) SCContentFilter *filter;
@property(nonatomic, strong) SCStreamConfiguration *config;
@property(nonatomic, strong) DLStreamOutput *output;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, assign) StatusCallback status;
@property(nonatomic, assign) void *context;
@property(atomic, assign) BOOL closing;
@property(atomic, assign) BOOL restarting;
- (NSError *)startStream;
@end
@implementation DLStreamSession
- (NSError *)startStream {
    __block NSError *failure = nil;
    self.stream = [[SCStream alloc] initWithFilter:self.filter configuration:self.config delegate:self];
    if (![self.stream addStreamOutput:self.output type:SCStreamOutputTypeScreen
                    sampleHandlerQueue:self.queue error:&failure]) return failure;
    dispatch_semaphore_t started = dispatch_semaphore_create(0);
    [self.stream startCaptureWithCompletionHandler:^(NSError *err) {
        failure = err;
        dispatch_semaphore_signal(started);
    }];
    if (dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)))
        return [NSError errorWithDomain:@"desklink.capture" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Timed out starting stream"}];
    return failure;
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (self.closing || self.restarting || stream != self.stream) return;
    self.restarting = YES;
    NSString *reason = [NSString stringWithFormat:@"SCStream stopped (%@ %ld): %@", error.domain, (long)error.code, error.localizedDescription];
    self.status(self.context, reason.UTF8String, false);
    NSLog(@"%@; restarting capture", reason);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        for (int attempt = 1; attempt <= 3 && !self.closing; attempt++) {
            [NSThread sleepForTimeInterval:attempt];
            if (self.closing) break;
            NSError *failure = [self startStream];
            if (!failure) {
                if (!self.closing) self.status(self.context, "SCStream restarted", true);
                self.restarting = NO;
                return;
            }
            NSLog(@"SCStream restart %d failed: %@", attempt, failure);
        }
        if (!self.closing) self.status(self.context, "SCStream restart exhausted", false);
        self.restarting = NO;
    });
}
@end

static void fail(char *error, size_t capacity, NSString *message) {
    if (capacity) snprintf(error, capacity, "%s", message.UTF8String ?: "ScreenCaptureKit failed");
}

extern "C" void *dl_mac_stream_start(uint32_t display_id, size_t width, size_t height, uint32_t fps,
                                      uint32_t indicator_pid, void *context, FrameCallback callback,
                                      StatusCallback status, char *error, size_t capacity) {
    @autoreleasepool {
        dispatch_semaphore_t found = dispatch_semaphore_create(0);
        __block SCShareableContent *content = nil;
        __block NSError *failure = nil;
        [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent *value, NSError *err) {
            content = value;
            failure = err;
            dispatch_semaphore_signal(found);
        }];
        if (dispatch_semaphore_wait(found, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) {
            fail(error, capacity, @"Timed out listing displays");
            return nullptr;
        }
        if (failure) { fail(error, capacity, failure.localizedDescription); return nullptr; }
        SCDisplay *display = nil;
        for (SCDisplay *candidate in content.displays)
            if (candidate.displayID == display_id) { display = candidate; break; }
        if (!display) { fail(error, capacity, @"Selected display is unavailable"); return nullptr; }
        NSMutableArray<SCWindow *> *excluded = [NSMutableArray array];
        if (indicator_pid) {
            for (SCWindow *window in content.windows)
                if (window.owningApplication.processID == (pid_t)indicator_pid)
                    [excluded addObject:window];
            if (!excluded.count) {
                fail(error, capacity, @"Agent indicator window not found for capture exclusion");
                return nullptr;
            }
        }
        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:excluded];
        SCStreamConfiguration *config = [SCStreamConfiguration new];
        config.width = width;
        config.height = height;
        config.pixelFormat = kCVPixelFormatType_32BGRA;
        config.minimumFrameInterval = CMTimeMake(1, fps ? fps : 30);
        config.queueDepth = 3;
        config.showsCursor = YES;
        config.capturesAudio = NO;
        DLStreamSession *session = [DLStreamSession new];
        session.output = [DLStreamOutput new];
        session.output.context = context;
        session.output.callback = callback;
        session.queue = dispatch_queue_create("dev.desklink.capture", DISPATCH_QUEUE_SERIAL);
        session.filter = filter;
        session.config = config;
        session.status = status;
        session.context = context;
        failure = [session startStream];
        if (failure) {
            fail(error, capacity, failure.localizedDescription);
            dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
            [session.stream stopCaptureWithCompletionHandler:^(NSError *err) {
                (void)err;
                dispatch_semaphore_signal(stopped);
            }];
            dispatch_semaphore_wait(stopped, DISPATCH_TIME_FOREVER);
            dispatch_sync(session.queue, ^{});
            return nullptr;
        }
        const char *simulate = getenv("DESKLINK_AXI_SIMULATE_STREAM_STOP_MS");
        int delay = simulate ? atoi(simulate) : 0;
        if (delay >= 100 && delay <= 60000) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)delay * NSEC_PER_MSEC),
                           dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
                if (session.closing) return;
                SCStream *stream = session.stream;
                [stream stopCaptureWithCompletionHandler:^(NSError *err) {
                    (void)err;
                    NSError *stopped = [NSError errorWithDomain:@"SCStreamErrorDomain" code:-3821
                        userInfo:@{NSLocalizedDescriptionKey: @"simulated systemStoppedStream"}];
                    [session stream:stream didStopWithError:stopped];
                }];
            });
        }
        return (__bridge_retained void *)session;
    }
}

extern "C" bool dl_mac_stream_stop(void *handle) {
    if (!handle) return true;
    @autoreleasepool {
        DLStreamSession *session = (__bridge_transfer DLStreamSession *)handle;
        session.closing = YES;
        for (int i = 0; session.restarting && i < 350; i++) [NSThread sleepForTimeInterval:0.1];
        if (session.restarting) {
            (void)CFBridgingRetain(session);
            return false; // The restart still owns the callback context.
        }
        dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
        [session.stream stopCaptureWithCompletionHandler:^(NSError *err) {
            (void)err;
            dispatch_semaphore_signal(stopped);
        }];
        if (dispatch_semaphore_wait(stopped, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC))) {
            // A late frame can still use the callback context; keep both alive rather than free it.
            (void)CFBridgingRetain(session);
            return false;
        }
        dispatch_sync(session.queue, ^{});
        return true;
    }
}
