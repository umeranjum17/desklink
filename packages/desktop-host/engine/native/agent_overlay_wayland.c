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
#include <fontconfig/fontconfig.h>
#include <ft2build.h>
#include FT_FREETYPE_H

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

/* xdg-output wire signatures: Copyright (c) 2017 Red Hat Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// xdg-output v2 supplies compositor logical coordinates, including scaled outputs.
static const struct wl_interface xdg_output_interface;
static const struct wl_interface *xdg_types[]={&xdg_output_interface,&wl_output_interface};
static const struct wl_message xdg_requests[]={{"destroy","",NULL},{"get_xdg_output","no",xdg_types}};
static const struct wl_interface xdg_manager_interface={"zxdg_output_manager_v1",2,2,xdg_requests,0,NULL};
static const struct wl_message output_requests[]={{"destroy","",NULL}};
static const struct wl_message output_events[]={{"logical_position","ii",NULL},{"logical_size","ii",NULL},{"done","",NULL},{"name","2s",NULL},{"description","2s",NULL}};
static const struct wl_interface xdg_output_interface={"zxdg_output_v1",2,1,output_requests,5,output_events};
struct Output { struct wl_output *handle; struct wl_proxy *logical; int x,y,w,h,valid; };
static void logical_position(void *data, struct wl_proxy *p,int32_t x,int32_t y){(void)p;struct Output *o=data;o->x=x;o->y=y;o->valid=1;}
static void logical_size(void *data,struct wl_proxy *p,int32_t w,int32_t h){(void)p;struct Output *o=data;o->w=w;o->h=h;}
static void logical_done(void *data,struct wl_proxy *p){(void)data;(void)p;}
static void logical_string(void *data,struct wl_proxy *p,const char *s){(void)data;(void)p;(void)s;}
static void (*logical_listener[])(void)={(void (*)(void))logical_position,(void (*)(void))logical_size,(void (*)(void))logical_done,(void (*)(void))logical_string,(void (*)(void))logical_string};

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
    struct wl_proxy *shell, *layer, *output_manager;
    struct Output outputs[32]; int output_count;
    struct wl_surface *surface;
    struct Buffer buffers[2];
    int width, height, source_w, source_h, configured, closed;
};
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec/1e9; }
static void registry_global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
    struct Overlay *o=data;
    if (!strcmp(interface,"wl_output") && o->output_count<32) {
        struct Output *out=&o->outputs[o->output_count++];
        out->handle=wl_registry_bind(registry,name,&wl_output_interface,1);
    }
    if (!strcmp(interface,"zxdg_output_manager_v1")) o->output_manager=wl_registry_bind(registry,name,&xdg_manager_interface,version<2?version:2);
    if (!strcmp(interface,"wl_compositor")) o->compositor=wl_registry_bind(registry,name,&wl_compositor_interface,version<4?version:4);
    if (!strcmp(interface,"wl_shm")) o->shm=wl_registry_bind(registry,name,&wl_shm_interface,1);
    if (!strcmp(interface,"zwlr_layer_shell_v1")) o->shell=wl_registry_bind(registry,name,&shell_interface,1);
}
static void registry_remove(void *data, struct wl_registry *registry, uint32_t name) { (void)data;(void)registry;(void)name; }
static const struct wl_registry_listener registry_listener={registry_global,registry_remove};
static void configured(void *data, struct wl_proxy *layer, uint32_t serial, uint32_t w, uint32_t h) {
    struct Overlay *o=data;
    // A source/layout change invalidates this helper; never write new dimensions
    // into buffers allocated for the old output size.
    if(o->configured && (o->width!=(int)w || o->height!=(int)h))o->closed=1;
    o->width=(int)w; o->height=(int)h; o->configured=1;
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

static FT_Face point_font(FT_Library *library) {
    if(FT_Init_FreeType(library))return NULL;
    FcPattern *pattern=FcNameParse((const FcChar8 *)"monospace");
    if(!pattern)return NULL;
    FcConfigSubstitute(NULL,pattern,FcMatchPattern);FcDefaultSubstitute(pattern);
    FcResult result;FcPattern *match=FcFontMatch(NULL,pattern,&result);FcPatternDestroy(pattern);
    FcChar8 *path=NULL;FT_Face face=NULL;
    if(match && FcPatternGetString(match,FC_FILE,0,&path)==FcResultMatch)
        if(!FT_New_Face(*library,(const char *)path,0,&face))FT_Set_Pixel_Sizes(face,0,13);
    if(match)FcPatternDestroy(match);
    return face;
}
static void draw_point(struct Overlay *o,struct Buffer *b,double x,double y,const char *label,FT_Face font,int visible) {
    memset(b->pixels,0,b->length);if(!visible)return;
    int w=o->width,h=o->height;
    for(int py=fmax(0,y-21);py<fmin(h,y+22);py++)for(int px=fmax(0,x-21);px<fmin(w,x+22);px++) {
        double d=hypot(px-x,py-y);
        if(fabs(d-18)<=2 || d<=3)b->pixels[(size_t)py*w+px]=0xff4c9ed0;
    }
    if(!*label)return;
    int badge_w=16;
    for(const char *p=label;*p;p++)if(!FT_Load_Char(font,(unsigned char)*p,FT_LOAD_DEFAULT))badge_w+=font->glyph->advance.x>>6;
    badge_w=fmin(w,badge_w);int bx=fmax(0,fmin(x+30,w-badge_w)),by=fmax(0,fmin(y-14,h-28));
    for(int py=by;py<fmin(h,by+28);py++)for(int px=bx;px<bx+badge_w;px++)b->pixels[(size_t)py*w+px]=0xff123047;
    int pen=bx+8;
    for(const char *p=label;*p;p++)if(!FT_Load_Char(font,(unsigned char)*p,FT_LOAD_RENDER)) {
        FT_GlyphSlot g=font->glyph;
        for(unsigned row=0;row<g->bitmap.rows;row++)for(unsigned col=0;col<g->bitmap.width;col++) {
            int px=pen+g->bitmap_left+col,py=by+18-g->bitmap_top+row;
            if(px<0||px>=w||py<0||py>=h)continue;
            unsigned a=g->bitmap.buffer[row*g->bitmap.pitch+col];
            unsigned r=(18*(255-a)+255*a)/255,green=(48*(255-a)+255*a)/255,blue=(71*(255-a)+255*a)/255;
            b->pixels[(size_t)py*w+px]=0xff000000|(r<<16)|(green<<8)|blue;
        }
        pen+=g->advance.x>>6;
    }
}

static int overlay_main(int source_w,int source_h,int point_mode,int origin_known,int origin_x,int origin_y) {

    struct Overlay o={.source_w=source_w,.source_h=source_h};
    o.display=wl_display_connect(NULL);
    if(!o.display)return 2;
    struct wl_registry *registry=wl_display_get_registry(o.display);
    wl_registry_add_listener(registry,&registry_listener,&o);
    wl_display_roundtrip(o.display);
    if(!o.shell){puts("layer_shell_unavailable");fflush(stdout);wl_display_disconnect(o.display);return 2;}
    if(!o.compositor||!o.shm){wl_display_disconnect(o.display);return 2;}
    struct wl_output *selected=NULL;int matches=0;
    if(point_mode) {
        if(o.output_manager) {
            for(int i=0;i<o.output_count;i++) {
                struct Output *out=&o.outputs[i];
                out->logical=wl_proxy_marshal_flags(o.output_manager,1,&xdg_output_interface,wl_proxy_get_version(o.output_manager),0,NULL,out->handle);
                wl_proxy_add_listener(out->logical,logical_listener,out);
            }
            if(wl_display_roundtrip(o.display)<0)return 2;
        }
        for(int i=0;i<o.output_count;i++) {
            struct Output *out=&o.outputs[i];
            if(origin_known && out->valid && origin_x>=out->x && origin_y>=out->y && origin_x<out->x+out->w && origin_y<out->y+out->h){selected=out->handle;matches++;}
        }
        if(matches>1)selected=NULL;
        if(!selected && o.output_count==1 && (!origin_known || !o.output_manager))selected=o.outputs[0].handle;
        if(!selected){puts("selected_output_unavailable");fflush(stdout);wl_display_disconnect(o.display);return 2;}
    }
    FT_Library library=NULL;FT_Face font=point_mode?point_font(&library):NULL;
    if(point_mode&&!font){wl_display_disconnect(o.display);return 2;}
    o.surface=wl_compositor_create_surface(o.compositor);
    o.layer=wl_proxy_marshal_flags(o.shell,0,&layer_surface_interface,1,0,NULL,o.surface,selected,3,point_mode?"desklink-point":"desklink-agent");
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
    double deadline=0;char label[97]={0};int dirty=0,visible=0;
    char pending[512];size_t used=0;
    while(!o.closed && (!ending||now()-ending<0.6)) {
        struct pollfd fds[2]={{wl_display_get_fd(o.display),POLLIN,0},{STDIN_FILENO,POLLIN|POLLHUP,0}};
        wl_display_flush(o.display);
        poll(fds,2,16);
        if(fds[0].revents&POLLIN && wl_display_dispatch(o.display)<0)break;
        else wl_display_dispatch_pending(o.display);
        char bytes[128];ssize_t n=read(STDIN_FILENO,bytes,sizeof(bytes));
        if(n==0){if(point_mode)break;if(!ending)ending=now();}
        for(ssize_t i=0;i<n;i++) {
            if(bytes[i]=='\n') {
                pending[used]=0;char kind=0;double px=0,py=0;
                if(sscanf(pending,"%c %lf %lf",&kind,&px,&py)>=1) {
                    if(point_mode && kind=='P') {
                        unsigned timeout=0;int offset=0;
                        if(sscanf(pending,"P %lf %lf %u %n",&px,&py,&timeout,&offset)==3 && offset && timeout>=1 && timeout<=120000 && strlen(pending+offset)<=96) {
                            desklink_wayland_geometry(o.source_w,o.source_h,o.width,o.height,px,py,&x,&y);
                            snprintf(label,sizeof(label),"%s",pending+offset);deadline=now()+timeout/1000.0;active=1;dirty=1;visible=1;
                        }
                    }
                    else if(kind=='S')ending=now();
                    else if(kind=='M'||kind=='C'||kind=='T'||kind=='A') {
                        if(px>=0&&py>=0) {
                            if(desklink_wayland_geometry(o.source_w,o.source_h,o.width,o.height,px,py,&tx,&ty)
                                && !positioned){x=tx;y=ty;positioned=1;}
                        }
                        active=1;
                        if(kind=='C')click=now();
                        if(kind=='T')typed=now();
                    }
                }
                used=0;
            }else if(used<sizeof(pending)-1)pending[used++]=bytes[i];
        }
        if(point_mode && visible && now()>=deadline){visible=0;dirty=1;}
        if(!active || (point_mode&&!dirty))continue;
        if(!point_mode){x+=(tx-x)*0.24;y+=(ty-y)*0.24;}
        for(int i=0;i<2;i++)if(!o.buffers[i].busy) {
            if(point_mode)draw_point(&o,&o.buffers[i],x,y,label,font,visible);
            else draw(&o,&o.buffers[i],x,y,click,typed,ending,positioned);
            dirty=0;
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
    if(font)FT_Done_Face(font);
    if(library)FT_Done_FreeType(library);
    wl_display_disconnect(o.display);
    return 0;
}

int desklink_agent_overlay_wayland(int w,int h){return overlay_main(w,h,0,0,0,0);}
int desklink_point_overlay_wayland(int w,int h,int known,int x,int y){return overlay_main(w,h,1,known,x,y);}

// Read-only capability probe for idempotent clear before a helper exists.
int desklink_wayland_layer_shell_available(void) {
    struct Overlay o={0};o.display=wl_display_connect(NULL);
    if(!o.display)return -1;
    struct wl_registry *registry=wl_display_get_registry(o.display);
    wl_registry_add_listener(registry,&registry_listener,&o);
    int ok=wl_display_roundtrip(o.display)>=0;
    int result=ok?(o.shell!=NULL):-1;
    wl_display_disconnect(o.display);return result;
}
