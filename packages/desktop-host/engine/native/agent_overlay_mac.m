#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

@interface AgentOverlayView : NSView {
    NSPoint target, cursor;
    CFTimeInterval clickAt, typeAt, endingAt;
    BOOL positioned;
}
- (void)event:(char)kind x:(double)x y:(double)y;
- (void)end;
@end

@implementation AgentOverlayView
- (BOOL)isOpaque { return NO; }
- (void)event:(char)kind x:(double)x y:(double)y {
    if (kind == 'S') { [self end]; return; }
    if (x >= 0 && y >= 0) {
        NSPoint point = NSMakePoint(x, self.bounds.size.height - y);
        target = point;
        if (!positioned) { cursor = point; positioned = YES; }
    }
    CFTimeInterval now = CACurrentMediaTime();
    if (kind == 'C') clickAt = now;
    if (kind == 'T') typeAt = now;
    [self setNeedsDisplay:YES];
}
- (void)end { endingAt = CACurrentMediaTime(); }
- (void)tick {
    if (endingAt && CACurrentMediaTime() - endingAt > 0.7) { [NSApp terminate:nil]; return; }
    cursor.x += (target.x - cursor.x) * 0.24;
    cursor.y += (target.y - cursor.y) * 0.24;
    [self setNeedsDisplay:YES];
}
- (void)drawRect:(NSRect)rect {
    [[NSColor clearColor] set]; NSRectFillUsingOperation(rect, NSCompositingOperationCopy);
    CFTimeInterval now = CACurrentMediaTime();
    CGFloat edge = endingAt ? fmax(0, 1 - (now-endingAt)/0.7) : 1;
    if (edge > 0) {
        NSRect bounds = self.bounds;
        [[NSColor colorWithCalibratedRed:0.28 green:0.67 blue:0.96 alpha:0.10*edge] set];
        NSBezierPath *border = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(bounds, 4, 4) xRadius:12 yRadius:12];
        border.lineWidth = 5; [border stroke];
    }
    if (!positioned) return;
    for (int i = 3; i >= 0; i--) {
        CGFloat radius = 12 + i*5;
        CGFloat alpha = 0.13 * (1.0 - i/5.0);
        [[NSColor colorWithCalibratedRed:0.30 green:0.73 blue:1 alpha:alpha] set];
        NSBezierPath *halo = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(cursor.x-radius, cursor.y-radius, radius*2, radius*2)];
        halo.lineWidth = 1.5 + i; [halo stroke];
    }
    if (clickAt && now-clickAt < 0.55) {
        CGFloat progress = (now-clickAt)/0.55;
        CGFloat radius = 11 + 37*progress;
        [[NSColor colorWithCalibratedRed:0.37 green:0.77 blue:1 alpha:0.45*(1-progress)] set];
        NSBezierPath *ripple = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(target.x-radius,target.y-radius,2*radius,2*radius)];
        ripple.lineWidth = 2.5*(1-progress)+0.5; [ripple stroke];
    }
    if (typeAt && now-typeAt < 0.4) {
        CGFloat progress = (now-typeAt)/0.4;
        CGFloat radius = 5 + progress*15;
        [[NSColor colorWithCalibratedRed:0.50 green:0.83 blue:1 alpha:0.32*(1-progress)] set];
        [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(target.x-radius,target.y-radius,2*radius,2*radius)] fill];
    }
}
@end

// The dev recording path converts ScreenCaptureKit screenshots to packed BGRA.
unsigned char *desklink_image_bgra(CGImageRef image, size_t *length, size_t *stride) {
    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    *stride = width * 4; *length = *stride * height;
    unsigned char *pixels = malloc(*length);
    if (!pixels) return NULL;
    CGColorSpaceRef color = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(pixels, width, height, 8, *stride, color,
                                                 kCGBitmapByteOrder32Little | kCGImageAlphaPremultipliedFirst);
    CGColorSpaceRelease(color);
    if (!context) { free(pixels); return NULL; }
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGContextRelease(context);
    return pixels;
}

int desklink_agent_overlay_main(int display_id) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
        NSScreen *screen = nil;
        for (NSScreen *candidate in [NSScreen screens]) {
            if ([candidate.deviceDescription[@"NSScreenNumber"] intValue] == display_id) { screen = candidate; break; }
        }
        if (!screen) return 2;
        NSWindow *window = [[NSWindow alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO screen:screen];
        window.opaque = NO; window.backgroundColor = NSColor.clearColor;
        window.ignoresMouseEvents = YES; window.hasShadow = NO;
        window.level = NSScreenSaverWindowLevel - 1;
        window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary;
        AgentOverlayView *view = [[AgentOverlayView alloc] initWithFrame:NSMakeRect(0,0,screen.frame.size.width,screen.frame.size.height)];
        window.contentView = view;
        [window orderFrontRegardless];
        puts("READY"); fflush(stdout);
        [NSTimer scheduledTimerWithTimeInterval:1.0/60 target:view selector:@selector(tick) userInfo:nil repeats:YES];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char line[128];
            while (fgets(line, sizeof(line), stdin)) {
                char kind; double x = 0, y = 0;
                if (sscanf(line, "%c %lf %lf", &kind, &x, &y) >= 1) {
                    dispatch_async(dispatch_get_main_queue(), ^{ [view event:kind x:x y:y]; });
                }
            }
            dispatch_async(dispatch_get_main_queue(), ^{ [view end]; });
        });
        [NSApp run];
        [window close];
    }
    return 0;
}
