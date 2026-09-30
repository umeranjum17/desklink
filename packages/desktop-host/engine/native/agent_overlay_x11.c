// The X server draws cursors outside GetImage(root). No overlay window can
// expose black pixels, intercept input, or poison agent frame diffs.
#include <X11/Xlib.h>
#include <X11/Xcursor/Xcursor.h>
#include <math.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec/1e9; }

static unsigned pixel(double distance, double radius, double opacity) {
    double edge = fmax(0, 1 - fabs(distance-radius)/2.5);
    unsigned alpha = (unsigned)(fmin(1, edge * opacity) * 255);
    return (alpha << 24) | 0x4c9ed0;
}

int desklink_agent_overlay_main(const char *display_name) {
    Display *d = XOpenDisplay(display_name);
    if (!d) return 2;
    Window root = DefaultRootWindow(d);
    unsigned best_w=64,best_h=64;
    XQueryBestCursor(d,root,64,64,&best_w,&best_h);
    unsigned size = best_w < best_h ? best_w : best_h;
    if (size < 32) { XCloseDisplay(d); return 2; }
    if (size > 96) size = 96;
    XcursorImage *image = XcursorImageCreate(size,size);
    if (!image) { XCloseDisplay(d); return 2; }
    image->version = XCURSOR_IMAGE_VERSION;
    Cursor previous = None;
    int stdin_flags = fcntl(STDIN_FILENO, F_GETFL);
    fcntl(STDIN_FILENO, F_SETFL, stdin_flags | O_NONBLOCK);
    puts("READY"); fflush(stdout);
    double target_x=0,target_y=0,cursor_x=0,cursor_y=0,click=0,typed=0,ending=0;
    int active=0;
    char pending[128]; size_t used=0;
    for (;;) {
        char bytes[128]; ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (n == 0 && !ending) ending=now();
        for (ssize_t i=0; i<n; i++) {
            if (bytes[i]=='\n') {
                pending[used]=0; char kind=0; double px=0,py=0;
                if (sscanf(pending,"%c %lf %lf",&kind,&px,&py)>=1) {
                    if (kind=='S') ending=now();
                    else if (kind=='M'||kind=='C'||kind=='T') {
                        if (px>=0 && py>=0) {
                            target_x=px; target_y=py;
                            if (!active) { cursor_x=px; cursor_y=py; }
                        }
                        active=1;
                        if (kind=='C') click=now();
                        if (kind=='T') typed=now();
                    }
                }
                used=0;
            } else if (used < sizeof(pending)-1) pending[used++]=bytes[i];
        }
        double t=now();
        if (ending && t-ending>0.55) break;
        if (active) {
            cursor_x += (target_x-cursor_x)*0.24;
            cursor_y += (target_y-cursor_y)*0.24;
            int radius=(int)size/2-3;
            image->xhot = (unsigned)fmax(0,fmin(size-1,(double)size/2+target_x-cursor_x));
            image->yhot = (unsigned)fmax(0,fmin(size-1,(double)size/2+target_y-cursor_y));
            for (unsigned y=0;y<size;y++) for (unsigned x=0;x<size;x++) {
                double distance=hypot(x-(double)size/2,y-(double)size/2);
                double opacity=ending ? fmax(0,1-(t-ending)/0.55) : 1;
                unsigned color=pixel(distance,12,0.72*opacity);
                if (distance>=16 && distance<=radius) {
                    unsigned outer=pixel(distance,20,0.20*opacity);
                    if ((outer>>24)>(color>>24)) color=outer;
                }
                if (click && t-click<0.5) {
                    double progress=(t-click)/0.5;
                    unsigned ripple=pixel(distance,12+(radius-14)*progress,0.6*(1-progress)*opacity);
                    if ((ripple>>24)>(color>>24)) color=ripple;
                }
                if (typed && t-typed<0.35) {
                    double progress=(t-typed)/0.35;
                    if (distance<5+progress*12) {
                        unsigned pulse=(unsigned)(0.22*(1-progress)*opacity*255);
                        if (pulse>(color>>24)) color=(pulse<<24)|0x5baed8;
                    }
                }
                image->pixels[y*size+x]=color;
            }
            Cursor next=XcursorImageLoadCursor(d,image);
            if (next!=None) {
                XDefineCursor(d,root,next); XFlush(d);
                if (previous!=None) XFreeCursor(d,previous);
                previous=next;
            }
        }
        usleep(16000);
    }
    XUndefineCursor(d,root); XFlush(d);
    if (previous!=None) XFreeCursor(d,previous);
    XcursorImageDestroy(image); XCloseDisplay(d);
    return 0;
}

// Point cues are independent of the real cursor. A shaped override-redirect
// window works without a compositor; an empty input shape passes every event
// through and mapping it never asks for keyboard focus. It intentionally appears
// in GetImage(root), so the local person and the video observer share the cue.
#include <X11/extensions/shape.h>
#include <stdlib.h>

int desklink_point_overlay_main(const char *display_name) {
    Display *d = XOpenDisplay(display_name);
    if (!d) return 2;
    int event_base, error_base;
    if (!XShapeQueryExtension(d, &event_base, &error_base)) { XCloseDisplay(d); return 2; }
    int screen = DefaultScreen(d), width = DisplayWidth(d, screen), height = DisplayHeight(d, screen);
    Window root = RootWindow(d, screen);
    XSetWindowAttributes attrs = {0};
    attrs.override_redirect = True;
    attrs.background_pixel = 0x4c9ed0;
    Window window = XCreateWindow(d, root, 0, 0, width, height, 0,
        CopyFromParent, InputOutput, CopyFromParent, CWOverrideRedirect | CWBackPixel, &attrs);
    XStoreName(d, window, "Desklink point");
    XShapeCombineRectangles(d, window, ShapeInput, 0, 0, NULL, 0, ShapeSet, Unsorted);
    Pixmap mask = XCreatePixmap(d, root, width, height, 1);
    GC shape = XCreateGC(d, mask, 0, NULL), ink = XCreateGC(d, window, 0, NULL);
    XFontStruct *font = XLoadQueryFont(d, "fixed");
    if (font) XSetFont(d, ink, font->fid);
    XSetLineAttributes(d, shape, 4, LineSolid, CapRound, JoinRound);
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
    puts("READY"); fflush(stdout);
    char pending[512]; size_t used = 0;
    double deadline = 0;
    for (;;) {
        char bytes[512]; ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (n == 0) break;
        for (ssize_t i = 0; i < n; i++) {
            if (bytes[i] != '\n') { if (used < sizeof(pending)-1) pending[used++] = bytes[i]; continue; }
            pending[used] = 0; used = 0;
            double px, py; unsigned timeout; int offset = 0;
            if (sscanf(pending, "P %lf %lf %u %n", &px, &py, &timeout, &offset) != 3 || !offset) continue;
            const char *label = pending + offset;
            int x = (int)px, y = (int)py, len = (int)strlen(label);
            int badge_w = font ? XTextWidth(font, label, len) + 16 : len * 6 + 16;
            if (badge_w > width) badge_w = width;
            int badge_x = x + 30, badge_y = y - 14;
            if (badge_x + badge_w > width) badge_x = width - badge_w;
            if (badge_y < 0) badge_y = 0;
            if (badge_y + 28 > height) badge_y = height - 28;
            XUnmapWindow(d, window);
            XSetForeground(d, shape, 0); XFillRectangle(d, mask, shape, 0, 0, width, height);
            XSetForeground(d, shape, 1);
            XDrawArc(d, mask, shape, x-18, y-18, 36, 36, 0, 360*64);
            XFillArc(d, mask, shape, x-3, y-3, 6, 6, 0, 360*64);
            if (len) XFillRectangle(d, mask, shape, badge_x, badge_y, badge_w, 28);
            XShapeCombineMask(d, window, ShapeBounding, 0, 0, mask, ShapeSet);
            XMapRaised(d, window);
            XClearWindow(d, window);
            if (len) {
                XSetForeground(d, ink, 0x123047);
                XFillRectangle(d, window, ink, badge_x, badge_y, badge_w, 28);
                XSetForeground(d, ink, 0xffffff);
                XDrawString(d, window, ink, badge_x+8, badge_y+18, label, len);
            }
            XSync(d, False);
            deadline = now() + timeout/1000.0;
        }
        if (deadline && now() >= deadline) { XUnmapWindow(d, window); XFlush(d); deadline = 0; }
        usleep(5000);
    }
    XDestroyWindow(d, window); XFreeGC(d, shape); XFreeGC(d, ink);
    XFreePixmap(d, mask); if (font) XFreeFont(d, font); XCloseDisplay(d);
    return 0;
}
