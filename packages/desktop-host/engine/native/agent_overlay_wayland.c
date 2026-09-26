// Minimal wlroots layer-shell surface: transparent, unfocusable and input-empty.
// Only the portal path uses it; X11 uses a cursor sprite instead.
// Protocol interface names/signatures from wlr-layer-shell-unstable-v1:
// Copyright (c) 2017 Drew DeVault. Permission is hereby granted to use, copy,
// modify and distribute this protocol for any purpose without fee, provided
// this notice appears in all copies. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
// WARRANTY OF ANY KIND; THE AUTHORS ARE NOT LIABLE FOR ANY CLAIM OR DAMAGES.
#define _GNU_SOURCE
#include <wayland-client.h>
#include <wayland-client-protocol.h>
#include <sys/mman.h>
#include <sys/poll.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Layer-shell v1 protocol (Drew DeVault, 2017; MIT license).
static const struct wl_interface layer_surface_interface;
static const struct wl_interface *get_surface_types[] = {
    &layer_surface_interface, &wl_surface_interface, &wl_output_interface, NULL
};
static const struct wl_message shell_requests[] = {
    {"get_layer_surface", "no?ous", get_surface_types}, {"destroy", "3", NULL}
};
static const struct wl_interface shell_interface = {"zwlr_layer_shell_v1", 1, 2, shell_requests, 0, NULL};
static const struct wl_message surface_requests[] = {
    {"set_size", "uu", NULL}, {"set_anchor", "u", NULL}, {"set_exclusive_zone", "i", NULL},
    {"set_margin", "iiii", NULL}, {"set_keyboard_interactivity", "u", NULL},
    {"get_popup", "o", NULL}, {"ack_configure", "u", NULL}, {"destroy", "", NULL}
};
static const struct wl_message surface_events[] = { {"configure", "uuu", NULL}, {"closed", "", NULL} };
static const struct wl_interface layer_surface_interface = {"zwlr_layer_surface_v1", 1, 8, surface_requests, 2, surface_events};

int desklink_wayland_geometry(int source_w, int source_h, int surface_w, int surface_h,
                             double px, double py, double *x, double *y) {
    if (source_w<=0||source_h<=0||surface_w<=0||surface_h<=0) return 0;
    *x=px*surface_w/source_w;*y=py*surface_h/source_h;
    return 1;
}
void desklink_wayland_policy(uint32_t *anchor, uint32_t *keyboard_focus, uint32_t *empty_input) {
    *anchor=15; *keyboard_focus=0; *empty_input=1;
}

struct Buffer { struct wl_buffer *handle; uint32_t *pixels; size_t length; int busy; };
struct Overlay {
    struct wl_display *display;
    struct wl_compositor *compositor;
    struct wl_shm *shm;
    struct wl_proxy *shell, *layer;
    struct wl_surface *surface;
    struct Buffer buffers[2];
    int width, height, source_w, source_h, configured, closed;
};
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec/1e9; }
static void registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    struct Overlay *o=data;
    if (!strcmp(interface,"wl_compositor")) o->compositor=wl_registry_bind(registry,name,&wl_compositor_interface,version<4?version:4);
    if (!strcmp(interface,"wl_shm")) o->shm=wl_registry_bind(registry,name,&wl_shm_interface,1);
    if (!strcmp(interface,"zwlr_layer_shell_v1")) o->shell=wl_registry_bind(registry,name,&shell_interface,1);
}
static void registry_remove(void *data, struct wl_registry *registry, uint32_t name) { (void)data;(void)registry;(void)name; }
static const struct wl_registry_listener registry_listener={registry_global,registry_remove};
static void configured(void *data, struct wl_proxy *layer, uint32_t serial, uint32_t w, uint32_t h) {
    struct Overlay *o=data; o->width=(int)w; o->height=(int)h; o->configured=1;
    wl_proxy_marshal_flags(layer,6,NULL,1,0,serial);
}
static void closed(void *data, struct wl_proxy *layer) { (void)layer; ((struct Overlay *)data)->closed=1; }
static void (*layer_listener[])(void)={(void (*)(void))configured,(void (*)(void))closed};
static void buffer_release(void *data, struct wl_buffer *buffer) { (void)buffer; ((struct Buffer *)data)->busy=0; }
static const struct wl_buffer_listener buffer_listener={buffer_release};

static int create_buffer(struct Overlay *o, struct Buffer *b) {
    b->length=(size_t)o->width*o->height*4;
    int fd=memfd_create("desklink-agent-overlay",MFD_CLOEXEC);
    if (fd<0 || ftruncate(fd,b->length)) { if(fd>=0)close(fd); return -1; }
    b->pixels=mmap(NULL,b->length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
    if (b->pixels==MAP_FAILED) {close(fd);return -1;}
    struct wl_shm_pool *pool=wl_shm_create_pool(o->shm,fd,(int)b->length);
    b->handle=wl_shm_pool_create_buffer(pool,0,o->width,o->height,o->width*4,WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool); close(fd);
    wl_buffer_add_listener(b->handle,&buffer_listener,b);
    return 0;
}
static void blend(uint32_t *pixel, unsigned alpha, unsigned rgb) {
    // premultiplied ARGB8888: the compositor blends this over the desktop.
    *pixel=(alpha<<24)|(((rgb>>16)&255)*alpha/255<<16)|(((rgb>>8)&255)*alpha/255<<8)|((rgb&255)*alpha/255);
}
static void draw(struct Overlay *o, struct Buffer *b, double x, double y, double click, double typed, double ending, int positioned) {
    double t=now(), opacity=ending?fmax(0,1-(t-ending)/0.6):1;
    memset(b->pixels,0,b->length);
    int w=o->width,h=o->height;
    for (int edge=0;edge<7;edge++) {
        unsigned alpha=(unsigned)((7-edge)*1.8*opacity);
        for(int px=edge;px<w-edge;px++) {
            blend(&b->pixels[(size_t)edge*w+px],alpha,0x4c9ed0);
            blend(&b->pixels[(size_t)(h-1-edge)*w+px],alpha,0x4c9ed0);
        }
        for(int py=edge;py<h-edge;py++) {
            blend(&b->pixels[(size_t)py*w+edge],alpha,0x4c9ed0);
            blend(&b->pixels[(size_t)py*w+w-1-edge],alpha,0x4c9ed0);
        }
    }
    int left=fmax(0,x-55),right=fmin(w,x+55),top=fmax(0,y-55),bottom=fmin(h,y+55);
    if(positioned)for(int py=top;py<bottom;py++)for(int px=left;px<right;px++) {
        double distance=hypot(px-x,py-y);
        double ring=fmax(0,1-fabs(distance-13)/5)*0.18;
        ring+=fmax(0,1-fabs(distance-23)/7)*0.06;
        if(click && t-click<0.55)ring+=fmax(0,1-fabs(distance-(12+37*(t-click)/0.55))/3)*0.42*(1-(t-click)/0.55);
        if(typed && t-typed<0.4)
            ring+=fmax(0,1-fabs(distance-(8+15*(t-typed)/0.4))/3)*0.22*(1-(t-typed)/0.4);
        unsigned alpha=(unsigned)(fmin(1,ring*opacity)*255);
        if(alpha)blend(&b->pixels[(size_t)py*w+px],alpha,0x4c9ed0);
    }
}

int desklink_agent_overlay_wayland(int source_w, int source_h) {
    struct Overlay o={.source_w=source_w,.source_h=source_h};
    o.display=wl_display_connect(NULL);
    if(!o.display)return 2;
    struct wl_registry *registry=wl_display_get_registry(o.display);
    wl_registry_add_listener(registry,&registry_listener,&o);
    wl_display_roundtrip(o.display);
    if(!o.compositor||!o.shm||!o.shell){wl_display_disconnect(o.display);return 2;}
    o.surface=wl_compositor_create_surface(o.compositor);
    o.layer=wl_proxy_marshal_flags(o.shell,0,&layer_surface_interface,1,0,NULL,o.surface,NULL,3,"desklink-agent");
    wl_proxy_add_listener(o.layer,layer_listener,&o);
    uint32_t anchor,keyboard_focus,empty_input;
    desklink_wayland_policy(&anchor,&keyboard_focus,&empty_input);
    wl_proxy_marshal_flags(o.layer,0,NULL,1,0,0u,0u);
    wl_proxy_marshal_flags(o.layer,1,NULL,1,0,anchor);
    wl_proxy_marshal_flags(o.layer,2,NULL,1,0,-1);
    wl_proxy_marshal_flags(o.layer,4,NULL,1,0,keyboard_focus);
    if(empty_input) {
        struct wl_region *empty=wl_compositor_create_region(o.compositor);
        wl_surface_set_input_region(o.surface,empty);
        wl_region_destroy(empty);
    }
    wl_surface_commit(o.surface);
    while(!o.configured&&!o.closed&&wl_display_dispatch(o.display)>=0) {}
    if(o.closed||o.width<=0||o.height<=0){wl_display_disconnect(o.display);return 2;}
    if(create_buffer(&o,&o.buffers[0])||create_buffer(&o,&o.buffers[1])){wl_display_disconnect(o.display);return 2;}
    int flags=fcntl(STDIN_FILENO,F_GETFL);fcntl(STDIN_FILENO,F_SETFL,flags|O_NONBLOCK);
    puts("READY");fflush(stdout);
    double tx=0,ty=0,x=0,y=0,click=0,typed=0,ending=0;
    int active=0,positioned=0;
    char pending[128];size_t used=0;
    while(!o.closed && (!ending||now()-ending<0.6)) {
        struct pollfd fds[2]={{wl_display_get_fd(o.display),POLLIN,0},{STDIN_FILENO,POLLIN|POLLHUP,0}};
        wl_display_flush(o.display);
        poll(fds,2,16);
        if(fds[0].revents&POLLIN && wl_display_dispatch(o.display)<0)break;
        else wl_display_dispatch_pending(o.display);
        char bytes[128];ssize_t n=read(STDIN_FILENO,bytes,sizeof(bytes));
        if(n==0&&!ending)ending=now();
        for(ssize_t i=0;i<n;i++) {
            if(bytes[i]=='\n') {
                pending[used]=0;char kind=0;double px=0,py=0;
                if(sscanf(pending,"%c %lf %lf",&kind,&px,&py)>=1) {
                    if(kind=='S')ending=now();
                    else if(kind=='M'||kind=='C'||kind=='T'||kind=='A') {
                        if(px>=0&&py>=0) {
                            if(desklink_wayland_geometry(o.source_w,o.source_h,o.width,o.height,px,py,&tx,&ty)
                                && !positioned){x=tx;y=ty;positioned=1;}
                        }
                        active=1;
                        if(kind=='C')click=now();if(kind=='T')typed=now();
                    }
                }
                used=0;
            }else if(used<sizeof(pending)-1)pending[used++]=bytes[i];
        }
        if(!active)continue;
        x+=(tx-x)*0.24;y+=(ty-y)*0.24;
        for(int i=0;i<2;i++)if(!o.buffers[i].busy) {
            draw(&o,&o.buffers[i],x,y,click,typed,ending,positioned);
            o.buffers[i].busy=1;
            wl_surface_attach(o.surface,o.buffers[i].handle,0,0);
            wl_surface_damage_buffer(o.surface,0,0,o.width,o.height);
            wl_surface_commit(o.surface);
            break;
        }
    }
    wl_surface_attach(o.surface,NULL,0,0);wl_surface_commit(o.surface);wl_display_roundtrip(o.display);
    for(int i=0;i<2;i++){wl_buffer_destroy(o.buffers[i].handle);munmap(o.buffers[i].pixels,o.buffers[i].length);}
    wl_proxy_destroy(o.layer);wl_surface_destroy(o.surface);wl_proxy_destroy(o.shell);
    wl_display_disconnect(o.display);
    return 0;
}
