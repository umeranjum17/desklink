#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>

@interface AgentOverlayView : NSView {
    NSPoint target, cursor;
    CFTimeInterval clickAt, typeAt, endingAt;
    BOOL positioned;
    BOOL pointMode, pointVisible;
    CFTimeInterval pointDeadline;
    NSString *pointLabel;
}
- (void)event:(char)kind x:(double)x y:(double)y;
- (void)end;
- (void)enablePointMode;
- (void)pointX:(double)x y:(double)y timeout:(unsigned)timeout label:(NSString *)label;
@end

@implementation AgentOverlayView
- (BOOL)isOpaque { return NO; }
- (void)enablePointMode { pointMode = YES; }
- (void)pointX:(double)x y:(double)y timeout:(unsigned)timeout label:(NSString *)label {
    cursor = NSMakePoint(x, self.bounds.size.height-y);
    pointLabel = label; pointVisible = YES;
    pointDeadline = CACurrentMediaTime() + timeout/1000.0;
    [self setNeedsDisplay:YES];
}
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
- (void)end { if (pointMode) { [NSApp terminate:nil]; return; } endingAt = CACurrentMediaTime(); }
- (void)tick {
    if (pointMode) {
        if (pointVisible && CACurrentMediaTime() >= pointDeadline) { pointVisible = NO; [self setNeedsDisplay:YES]; }
        return;
    }
    if (endingAt && CACurrentMediaTime() - endingAt > 0.7) { [NSApp terminate:nil]; return; }
    cursor.x += (target.x - cursor.x) * 0.24;
    cursor.y += (target.y - cursor.y) * 0.24;
    [self setNeedsDisplay:YES];
}
- (void)drawRect:(NSRect)rect {
    [[NSColor clearColor] set]; NSRectFillUsingOperation(rect, NSCompositingOperationCopy);
    if (pointMode) {
        if (!pointVisible) return;
        [[NSColor colorWithCalibratedRed:0.30 green:0.62 blue:0.82 alpha:1] set];
        NSBezierPath *ring = [NSBezierPath bezierPathWithOvalInRect:NSMakeRect(cursor.x-18, cursor.y-18, 36, 36)];
        ring.lineWidth = 4; [ring stroke];
        [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(cursor.x-3,cursor.y-3,6,6)] fill];
        if (pointLabel.length) {
            NSDictionary *style = @{NSFontAttributeName: [NSFont systemFontOfSize:13], NSForegroundColorAttributeName: NSColor.whiteColor};
            NSSize size = [pointLabel sizeWithAttributes:style];
            CGFloat x = fmax(0, fmin(cursor.x+30, self.bounds.size.width-size.width-16));
            CGFloat y = fmax(0, fmin(cursor.y-14, self.bounds.size.height-28));
            [[NSColor colorWithCalibratedRed:0.07 green:0.19 blue:0.28 alpha:1] set];
            [[NSBezierPath bezierPathWithRoundedRect:NSMakeRect(x,y,size.width+16,28) xRadius:4 yRadius:4] fill];
            [pointLabel drawAtPoint:NSMakePoint(x+8,y+6) withAttributes:style];
        }
        return;
    }
    CFTimeInterval now = CACurrentMediaTime();
    CGFloat edge = endingAt ? fmax(0, 1 - (now-endingAt)/0.7) : 1;
    if (edge > 0) {
        NSRect bounds = self.bounds;
        [[NSColor colorWithCalibratedRed:0.28 green:0.67 blue:0.96 alpha:0.75*edge] set];
        NSBezierPath *border = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(bounds, 4, 4) xRadius:12 yRadius:12];
        border.lineWidth = 5; [border stroke];
    }
    if (!positioned) return;
    NSBezierPath *pointer = [NSBezierPath bezierPath];
    [pointer moveToPoint:NSMakePoint(cursor.x, cursor.y)];
    [pointer lineToPoint:NSMakePoint(cursor.x+2, cursor.y-24)];
    [pointer lineToPoint:NSMakePoint(cursor.x+8, cursor.y-18)];
    [pointer lineToPoint:NSMakePoint(cursor.x+15, cursor.y-31)];
    [pointer lineToPoint:NSMakePoint(cursor.x+21, cursor.y-28)];
    [pointer lineToPoint:NSMakePoint(cursor.x+14, cursor.y-15)];
    [pointer lineToPoint:NSMakePoint(cursor.x+24, cursor.y-14)];
    [pointer closePath];
    [[NSColor colorWithCalibratedRed:0.16 green:0.60 blue:1 alpha:1] set]; [pointer fill];
    [[NSColor whiteColor] set]; pointer.lineWidth = 2; [pointer stroke];
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

static int overlay_main(int display_id, BOOL point_mode) {
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
        if (point_mode) [view enablePointMode];
        NSPoint mouse = [NSEvent mouseLocation];
        if (!point_mode) [view event:'M' x:mouse.x-screen.frame.origin.x y:NSMaxY(screen.frame)-mouse.y];
        [window orderFrontRegardless];
        puts("READY"); fflush(stdout);
        [NSTimer scheduledTimerWithTimeInterval:1.0/60 target:view selector:@selector(tick) userInfo:nil repeats:YES];
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            char line[512];
            while (fgets(line, sizeof(line), stdin)) {
                if (point_mode) {
                    double x, y; unsigned timeout; int offset = 0;
                    if (sscanf(line, "P %lf %lf %u %n", &x, &y, &timeout, &offset) == 3 && offset) {
                        line[strcspn(line, "\n")] = 0;
                        NSString *label = [NSString stringWithUTF8String:line+offset];
                        dispatch_async(dispatch_get_main_queue(), ^{ [view pointX:x y:y timeout:timeout label:label]; });
                    }
                    continue;
                }
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

int desklink_agent_overlay_main(int display_id) { return overlay_main(display_id, NO); }
int desklink_point_overlay_main(int display_id) { return overlay_main(display_id, YES); }
