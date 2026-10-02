// Shared Linux agent cue, in logical pixels. The arrow follows the Mac outline;
// light and dark keylines keep it visible on both bright and dark desktops.
#ifndef DESKLINK_AGENT_INDICATOR_H
#define DESKLINK_AGENT_INDICATOR_H
#include <math.h>
#include <stdint.h>

static double indicator_segment(double x, double y, double ax, double ay, double bx, double by) {
    double dx=bx-ax, dy=by-ay;
    double t=fmax(0,fmin(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)));
    return hypot(x-ax-t*dx,y-ay-t*dy);
}
static uint32_t indicator_over(uint32_t dst, double coverage, unsigned rgb) {
    unsigned a=(unsigned)(255*fmax(0,fmin(1,coverage))), inverse=255-a;
    unsigned da=dst>>24, r=(dst>>16)&255, g=(dst>>8)&255, b=dst&255;
    return ((a+da*inverse/255)<<24) |
        ((((rgb>>16)&255)*a/255+r*inverse/255)<<16) |
        ((((rgb>>8)&255)*a/255+g*inverse/255)<<8) |
        ((rgb&255)*a/255+b*inverse/255);
}
// Recolour without changing coverage, so feedback on a still cue never
// changes which pixels capture has to restore.
static uint32_t indicator_tint(uint32_t c, double amount, unsigned rgb) {
    double keep=1-fmax(0,fmin(1,amount)), a=(c>>24)/255.0;
    return (c&0xff000000) |
        ((unsigned)(((c>>16)&255)*keep+((rgb>>16)&255)*a*(1-keep))<<16) |
        ((unsigned)(((c>>8)&255)*keep+((rgb>>8)&255)*a*(1-keep))<<8) |
        (unsigned)((c&255)*keep+(rgb&255)*a*(1-keep));
}
static uint32_t indicator_pixel(double x, double y, double opacity, double click, double typed) {
    double radius=hypot(x,y);
    uint32_t color=0;
    // 62 logical px halo: a blue band, wide white keyline and dark rim, so the
    // ring keeps >=2px of contrast after a 2:1 downscale. Inside the band only
    // the arrow is opaque, so capture can keep the click area live.
    color=indicator_over(color,fmax(0,fmin(1,2.5-fabs(radius-28.5)))*opacity,0x123047);
    color=indicator_over(color,fmax(0,fmin(1,2.5-fabs(radius-24)))*opacity,0xffffff);
    color=indicator_over(color,fmax(0,fmin(1,1.5-fabs(radius-20)))*0.95*opacity,0x2999ff);
    static const double arrow[][2]={{0,0},{2,24},{8,18},{15,31},{21,28},{14,15},{24,14}};
    double distance=1000; int inside=0;
    for(int i=0,j=6;i<7;j=i++) {
        double ax=arrow[j][0],ay=arrow[j][1],bx=arrow[i][0],by=arrow[i][1];
        distance=fmin(distance,indicator_segment(x,y,ax,ay,bx,by));
        if((ay>y)!=(by>y) && x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
    }
    double signed_distance=inside?-distance:distance;
    color=indicator_over(color,fmax(0,fmin(1,3-signed_distance))*opacity,0x123047);
    color=indicator_over(color,fmax(0,fmin(1,2-signed_distance))*opacity,0xffffff);
    color=indicator_over(color,fmax(0,fmin(1,-signed_distance))*opacity,0x2999ff);
    // A click sweeps a bright wave out through the cue; a key flashes it.
    if(click>=0 && click<1)
        color=indicator_tint(color,fmax(0,1-fabs(radius-(4+32*click))/5)*0.9*(1-click),0x9fdcff);
    if(typed>=0 && typed<1)
        color=indicator_tint(color,0.6*(1-typed),0xc8ecff);
    return color;
}
#endif
