#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreMedia/CoreMedia.h>

using FrameCallback = void (*)(void *, const uint8_t *, size_t, size_t, size_t, size_t);

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

@interface DLStreamSession : NSObject
@property(nonatomic, strong) SCStream *stream;
@property(nonatomic, strong) DLStreamOutput *output;
@property(nonatomic, strong) dispatch_queue_t queue;
@end
@implementation DLStreamSession
@end

static void fail(char *error, size_t capacity, NSString *message) {
    if (capacity) snprintf(error, capacity, "%s", message.UTF8String ?: "ScreenCaptureKit failed");
}

extern "C" void *dl_mac_stream_start(uint32_t display_id, size_t width, size_t height, uint32_t fps,
                                      uint32_t indicator_pid, void *context, FrameCallback callback,
                                      char *error, size_t capacity) {
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
        session.stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];
        if (![session.stream addStreamOutput:session.output type:SCStreamOutputTypeScreen
                          sampleHandlerQueue:session.queue error:&failure]) {
            fail(error, capacity, failure.localizedDescription);
            return nullptr;
        }
        dispatch_semaphore_t started = dispatch_semaphore_create(0);
        [session.stream startCaptureWithCompletionHandler:^(NSError *err) {
            failure = err;
            dispatch_semaphore_signal(started);
        }];
        if (dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) || failure) {
            fail(error, capacity, failure ? failure.localizedDescription : @"Timed out starting stream");
            dispatch_semaphore_t stopped = dispatch_semaphore_create(0);
            [session.stream stopCaptureWithCompletionHandler:^(NSError *err) {
                (void)err;
                dispatch_semaphore_signal(stopped);
            }];
            dispatch_semaphore_wait(stopped, DISPATCH_TIME_FOREVER);
            dispatch_sync(session.queue, ^{});
            return nullptr;
        }
        return (__bridge_retained void *)session;
    }
}

extern "C" bool dl_mac_stream_stop(void *handle) {
    if (!handle) return true;
    @autoreleasepool {
        DLStreamSession *session = (__bridge_transfer DLStreamSession *)handle;
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
