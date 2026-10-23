// The agent cue is a click-through override-redirect window that follows the
// pointer, so it stays visible over windows that set their own cursor and never
// replaces the person's cursor. With a compositing manager it uses an ARGB
// visual; without one, a 1-bit shape. It appears in GetImage(root), so each
// state is reported on stdout before it is drawn and the engine restores the
// covered pixels in X11 capture (desklink_indicator_covered below).
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xresource.h>
#include <X11/extensions/shape.h>
#include <math.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "agent_indicator.h"

// The same coverage test the helper draws with, for the engine's capture mask.
int desklink_indicator_covered(double x, double y, double opacity, double click, double typed, unsigned threshold, double reveal) {
    return hypot(x,y)<reveal && (indicator_pixel(x,y,opacity,click,typed)>>24) >= threshold;
}

static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec/1e9; }

static double desktop_scale(Display *d) {
    double scale=1;
    const char *resources=XResourceManagerString(d);
    if(!resources) return scale;
    XrmInitialize(); XrmDatabase db=XrmGetStringDatabase(resources);
    XrmValue value; char *type;
    if(db && XrmGetResource(db,"Xft.dpi","Xft.Dpi",&type,&value) && value.addr) {
        double dpi=strtod(value.addr,NULL);
        if(isfinite(dpi) && dpi>=96 && dpi<=384)scale=dpi/96;
    }
    if(db)XrmDestroyDatabase(db);
    return scale;
}

int desklink_agent_overlay_main(const char *display_name) {
    Display *d = XOpenDisplay(display_name);
    if (!d) return 2;
    int event_base, error_base, screen=DefaultScreen(d);
    if (!XShapeQueryExtension(d,&event_base,&error_base)) { XCloseDisplay(d); return 2; }
    Window root = RootWindow(d,screen);
    double scale=desktop_scale(d);
    // The arrow reaches 36 logical px from the cue's center.
    int size=(int)ceil(80*scale);
    char selection[32]; snprintf(selection,sizeof(selection),"_NET_WM_CM_S%d",screen);
    XVisualInfo argb;
    int alpha = XGetSelectionOwner(d,XInternAtom(d,selection,False))!=None
        && XMatchVisualInfo(d,screen,32,TrueColor,&argb);
    XSetWindowAttributes attrs={0};
    attrs.override_redirect=True;
    attrs.background_pixmap=None;
    attrs.border_pixel=0;
    unsigned long mask=CWOverrideRedirect|CWBackPixmap|CWBorderPixel;
    Visual *visual=DefaultVisual(d,screen); int depth=DefaultDepth(d,screen);
    if(alpha) {
        visual=argb.visual; depth=32;
        attrs.colormap=XCreateColormap(d,root,visual,AllocNone); mask|=CWColormap;
    } else if(depth<24) { XCloseDisplay(d); return 2; }
    Window window=XCreateWindow(d,root,0,0,size,size,0,depth,InputOutput,visual,mask,&attrs);
    XStoreName(d,window,"Desklink agent");
    XShapeCombineRectangles(d,window,ShapeInput,0,0,NULL,0,ShapeSet,Unsorted);
    XSelectInput(d,window,ExposureMask);
    XSelectInput(d,root,SubstructureNotifyMask);
    GC gc=XCreateGC(d,window,0,NULL);
    uint32_t *pixels=calloc((size_t)size*size,4);
    int row=(size+7)/8;
    char *bits=calloc((size_t)row*size,1);
    XImage *image=pixels?XCreateImage(d,visual,depth,ZPixmap,0,(char *)pixels,size,size,32,0):NULL;
    if(!image || !bits || image->bits_per_pixel!=32) { XCloseDisplay(d); return 2; }
    int stdin_flags = fcntl(STDIN_FILENO, F_GETFL);
    fcntl(STDIN_FILENO, F_SETFL, stdin_flags | O_NONBLOCK);
    puts("READY"); fflush(stdout);
    double target_x=0,target_y=0,cue_x=0,cue_y=0,click=0,typed=0,ending=0,started=0;
    int active=0,mapped=0,redraw=0,was_animating=0,last_x=-100000,last_y=-100000;
    char pending[128]; size_t used=0;
    for (;;) {
        char bytes[128]; ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (n == 0 && !ending) ending=now();
        for (ssize_t i=0; i<n; i++) {
            if (bytes[i]=='\n') {
                pending[used]=0; char kind=0; double px=0,py=0;
                if (sscanf(pending,"%c %lf %lf",&kind,&px,&py)>=1) {
                    if (kind=='S') ending=now();
                    else if ((kind=='M'||kind=='C'||kind=='T') && (active || (px>=0 && py>=0))) {
                        if (px>=0 && py>=0) {
                            target_x=px; target_y=py;
                            if (!active) { cue_x=px; cue_y=py; }
                        }
                        if (!active) started=now();
                        active=1;
                        if (kind=='C') click=now();
                        if (kind=='T') typed=now();
                    }
                }
                used=0;
            } else if (used < sizeof(pending)-1) pending[used++]=bytes[i];
        }
        while (XPending(d)) {
            XEvent event; XNextEvent(d,&event);
            if (event.type==Expose && event.xexpose.window==window) redraw=1;
            // Stay above windows and menus mapped or restacked after us.
            if (mapped && ((event.type==MapNotify && event.xmap.window!=window)
                || (event.type==ConfigureNotify && event.xconfigure.window!=window))) XRaiseWindow(d,window);
        }
        double t=now();
        if (ending && (!active || t-ending>0.55)) break;
        if (active) {
            cue_x += (target_x-cue_x)*0.24;
            cue_y += (target_y-cue_y)*0.24;
            double opacity=ending ? fmax(0,1-(t-ending)/0.55) : fmin(1,(t-started)/0.18);
            double c=click?(t-click)/0.55:-1, k=typed?(t-typed)/0.4:-1;
            int animating = opacity<1 || (c>=0 && c<1) || (k>=0 && k<1);
            // One more frame once an animation ends, so the rest state is exact.
            if (!animating && was_animating) redraw=1;
            was_animating=animating;
            int x=(int)lround(cue_x), y=(int)lround(cue_y);
            if (animating || redraw || x!=last_x || y!=last_y) {
                // A 1-bit shape cannot fade: reveal outward from the tip and
                // retract inward, so coverage only grows while appearing and a
                // still cue never uncovers stale pixels.
                double unit=scale, reveal=alpha?99:40*opacity*(2-opacity);
                memset(bits,0,(size_t)row*size);
                for (int py=0;py<size;py++) for (int px=0;px<size;px++) {
                    double lx=(px-size/2.0)/unit, ly=(py-size/2.0)/unit;
                    uint32_t color=hypot(lx,ly)<reveal?indicator_pixel(lx,ly,alpha?opacity:1,c,k):0;
                    unsigned a=color>>24;
                    if (alpha) { pixels[py*size+px]=color; continue; }
                    if (a<128) { pixels[py*size+px]=0; continue; }
                    bits[py*row+px/8]|=(char)(1<<(px%8));
                    // Un-premultiply: the shaped path paints opaque pixels.
                    pixels[py*size+px]=((((color>>16)&255)*255/a)<<16)|((((color>>8)&255)*255/a)<<8)|((color&255)*255/a);
                }
                // Announce first: capture reads this pipe after each grab, so
                // every state a grab can see is already announced.
                printf("P %d %d %d %.6f %.4f %.4f %.4f %u %.4f\n",x-size/2,y-size/2,size,unit,alpha?opacity:1,c,k,alpha?1u:128u,reveal);
                // No reader means the engine is gone: leave at once rather
                // than animate unmasked into whatever captures next.
                if (fflush(stdout)) break;
                if (!alpha) {
                    Pixmap shape=XCreateBitmapFromData(d,window,bits,size,size);
                    XShapeCombineMask(d,window,ShapeBounding,0,0,shape,ShapeSet);
                    XFreePixmap(d,shape);
                }
                if (x!=last_x || y!=last_y) XMoveWindow(d,window,x-size/2,y-size/2);
                if (!mapped) { XMapRaised(d,window); mapped=1; }
                XPutImage(d,window,gc,image,0,0,0,0,size,size);
                // Wait until the server has drawn it, so at most the newest
                // announced state is not on screen yet.
                XSync(d,False);
                last_x=x; last_y=y; redraw=0;
            }
        }
        usleep(16000);
    }
    XDestroyWindow(d,window);
    XDestroyImage(image); free(bits);
    XFreeGC(d,gc); XCloseDisplay(d);
    return 0;
}

// The ring is 72 logical px across, a 6px band with a pulse wave that grows
// out from it every PULSE_SECONDS, so the cue reads at a glance. The label is
// the core "fixed" font drawn at 2x, because a core X server offers nothing larger.
#define POINT_RING 36
#define POINT_PULSE_SECONDS 1.2
#define POINT_BADGE_H 40
#define POINT_FRAME_SECONDS 0.033

static void point_shape(Display *d, Window window, Pixmap mask, GC shape, int x, int y,
    int badge_x, int badge_y, int badge_w, double elapsed) {
    double phase = fmod(elapsed, POINT_PULSE_SECONDS) / POINT_PULSE_SECONDS;
    int wave = POINT_RING + (int)lround(18*phase), wave_width = 6 - (int)lround(4*phase);
    XSetForeground(d, shape, 0); XFillRectangle(d, mask, shape, 0, 0, 0xffff, 0xffff);
    XSetForeground(d, shape, 1);
    XSetLineAttributes(d, shape, 6, LineSolid, CapRound, JoinRound);
    XDrawArc(d, mask, shape, x-POINT_RING, y-POINT_RING, 2*POINT_RING, 2*POINT_RING, 0, 360*64);
    XFillArc(d, mask, shape, x-6, y-6, 12, 12, 0, 360*64);
    XSetLineAttributes(d, shape, wave_width, LineSolid, CapRound, JoinRound);
    XDrawArc(d, mask, shape, x-wave, y-wave, 2*wave, 2*wave, 0, 360*64);
    if (badge_w) XFillRectangle(d, mask, shape, badge_x, badge_y, badge_w, POINT_BADGE_H);
    XShapeCombineMask(d, window, ShapeBounding, 0, 0, mask, ShapeSet);
}

// Text is rasterised once at 1x and drawn as 2x2 blocks.
static void point_text(Display *d, Window window, GC ink, XFontStruct *font, const char *label,
    int len, int x, int y) {
    int w = XTextWidth(font, label, len), h = font->ascent + font->descent;
    Pixmap bits = XCreatePixmap(d, window, w, h, 1);
    GC gc = XCreateGC(d, bits, 0, NULL);
    XSetFont(d, gc, font->fid);
    XSetForeground(d, gc, 0); XFillRectangle(d, bits, gc, 0, 0, w, h);
    XSetForeground(d, gc, 1); XDrawString(d, bits, gc, 0, font->ascent, label, len);
    XImage *image = XGetImage(d, bits, 0, 0, w, h, 1, ZPixmap);
    XRectangle *blocks = malloc(sizeof(XRectangle) * (size_t)w * h);
    int count = 0;
    if (image && blocks)
        for (int row = 0; row < h; row++) for (int col = 0; col < w; col++)
            if (XGetPixel(image, col, row))
                blocks[count++] = (XRectangle){(short)(x+2*col), (short)(y+2*row), 2, 2};
    if (count) XFillRectangles(d, window, ink, blocks, count);
    free(blocks); if (image) XDestroyImage(image);
    XFreeGC(d, gc); XFreePixmap(d, bits);
}

// Point cues are independent of the real cursor. A shaped override-redirect
// window works without a compositor; an empty input shape passes every event
// through and mapping it never asks for keyboard focus. It intentionally appears
// in GetImage(root), so the local person and the video observer share the cue.

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
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
    puts("READY"); fflush(stdout);
    char pending[512]; size_t used = 0;
    double deadline = 0, started = 0, drawn = 0;
    int x = 0, y = 0, badge_x = 0, badge_y = 0, badge_w = 0;
    for (;;) {
        char bytes[512]; ssize_t n = read(STDIN_FILENO, bytes, sizeof(bytes));
        if (n == 0) break;
        for (ssize_t i = 0; i < n; i++) {
            if (bytes[i] != '\n') { if (used < sizeof(pending)-1) pending[used++] = bytes[i]; continue; }
            pending[used] = 0; used = 0;
            double px, py; unsigned timeout; int offset = 0;
            if (sscanf(pending, "P %lf %lf %u %n", &px, &py, &timeout, &offset) != 3 || !offset) continue;
            const char *label = pending + offset;
            int len = (int)strlen(label);
            x = (int)px; y = (int)py;
            int text_w = font ? 2*XTextWidth(font, label, len) : 12*len;
            badge_w = len ? text_w + 24 : 0;
            if (badge_w > width) badge_w = width;
            badge_x = x + POINT_RING + 30; badge_y = y - POINT_BADGE_H/2;
            if (badge_x + badge_w > width) badge_x = width - badge_w;
            if (badge_y < 0) badge_y = 0;
            if (badge_y + POINT_BADGE_H > height) badge_y = height - POINT_BADGE_H;
            XUnmapWindow(d, window);
            started = now();
            point_shape(d, window, mask, shape, x, y, badge_x, badge_y, badge_w, 0);
            XMapRaised(d, window);
            XClearWindow(d, window);
            if (len) {
                XSetForeground(d, ink, 0x123047);
                XFillRectangle(d, window, ink, badge_x, badge_y, badge_w, POINT_BADGE_H);
                XSetForeground(d, ink, 0xffffff);
                if (font) point_text(d, window, ink, font, label, len, badge_x+12,
                    badge_y + (POINT_BADGE_H - 2*(font->ascent+font->descent))/2);
            }
            XSync(d, False);
            drawn = now();
            deadline = drawn + timeout/1000.0;
        }
        double t = now();
        if (deadline && t >= deadline) { XUnmapWindow(d, window); XFlush(d); deadline = 0; }
        else if (deadline && t - drawn >= POINT_FRAME_SECONDS) {
            point_shape(d, window, mask, shape, x, y, badge_x, badge_y, badge_w, t - started);
            XFlush(d); drawn = t;
        }
        usleep(5000);
    }
    XDestroyWindow(d, window); XFreeGC(d, shape); XFreeGC(d, ink);
    XFreePixmap(d, mask); if (font) XFreeFont(d, font); XCloseDisplay(d);
    return 0;
}

