// Native indicator evidence. X11 MUST enter through flow.mjs's verified Xvfb.
// Wayland owns an isolated headless compositor/socket, never the ambient desktop.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { assertNoAmbientDesktop } from '../../desktop-host/test/lab-safety.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const colors = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00', white: '#ffffff', dark: '#101820' };
function run(command,args,env) {
    const r=spawnSync(command,args,{env,encoding:'utf8',timeout:15000});
    assert.equal(r.status,0,`${command}: ${r.stderr}`); return r.stdout;
}
async function stop(p,signal='SIGTERM') {
    if(p.exitCode!==null || p.signalCode!==null)return;
    const done=new Promise(r=>p.once('exit',r)); p.kill(signal); await done;
}
async function ready(p) {
    let out='';
    await new Promise((ok,no)=> {
        const timer=setTimeout(()=>no(new Error(`helper readiness timeout: ${out}`)),5000);
        p.stdout.on('data',b=>{out+=b;if(out.includes('READY')){clearTimeout(timer);ok();}});
        p.once('exit',code=>{clearTimeout(timer);no(new Error(`helper exited ${code}: ${out}`));});
    });
}
// Use only the already verified task X server, including DPI and pointer setup.
const xfixture = `import ctypes,sys
x=ctypes.CDLL('libX11.so.6')
x.XOpenDisplay.restype=ctypes.c_void_p
x.XDefaultRootWindow.argtypes=[ctypes.c_void_p];x.XDefaultRootWindow.restype=ctypes.c_ulong
x.XSetWindowBackground.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong]
x.XClearWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
x.XWarpPointer.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint,ctypes.c_int,ctypes.c_int]
x.XInternAtom.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int];x.XInternAtom.restype=ctypes.c_ulong
x.XChangeProperty.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_int,ctypes.c_int,ctypes.c_char_p,ctypes.c_int]
x.XSync.argtypes=[ctypes.c_void_p,ctypes.c_int];x.XCloseDisplay.argtypes=[ctypes.c_void_p]
d=x.XOpenDisplay(None);assert d
root=x.XDefaultRootWindow(d)
if sys.argv[1]=='appwin':
 # Demo application window that sets its own text cursor, like most real apps.
 x.XCreateSimpleWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_int,ctypes.c_int,ctypes.c_uint,ctypes.c_uint,ctypes.c_uint,ctypes.c_ulong,ctypes.c_ulong];x.XCreateSimpleWindow.restype=ctypes.c_ulong
 x.XCreateFontCursor.argtypes=[ctypes.c_void_p,ctypes.c_uint];x.XCreateFontCursor.restype=ctypes.c_ulong
 x.XDefineCursor.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong];x.XMapWindow.argtypes=[ctypes.c_void_p,ctypes.c_ulong]
 w=x.XCreateSimpleWindow(d,root,0,0,int(sys.argv[2]),int(sys.argv[3]),0,0,0xffffff)
 x.XDefineCursor(d,w,x.XCreateFontCursor(d,152));x.XMapWindow(d,w);x.XSync(d,0)
 print('READY',flush=True)
 for line in sys.stdin:
  x.XSetWindowBackground(d,w,int(line.strip()[1:],16));x.XClearWindow(d,w);x.XSync(d,0)
 x.XCloseDisplay(d);sys.exit(0)
if sys.argv[1]=='dpi':
 data=('Xft.dpi: '+sys.argv[2]+'\\n').encode();x.XChangeProperty(d,root,x.XInternAtom(d,b'RESOURCE_MANAGER',0),31,8,0,data,len(data))
else:
 x.XSetWindowBackground(d,root,int(sys.argv[1][1:],16));x.XClearWindow(d,root)
 x.XWarpPointer(d,0,root,0,0,0,0,int(sys.argv[2]),int(sys.argv[3]))
x.XSync(d,0);x.XCloseDisplay(d)
`;
// WCAG contrast of the downscaled still against the plain background, sampled
// on the halo ring (radius 12 in every 960x540 still at 1x and 2x).
const luminance = ([r,g,b]) => [r,g,b].map(v => { v/=255; return v<=0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; })
    .reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
const contrast = (a,b) => { const [x,y]=[luminance(a),luminance(b)].sort((p,q)=>q-p); return (x+0.05)/(y+0.05); };
export function legibility(path, background) {
    const png=PNG.sync.read(readFileSync(path)), at=(x,y)=>{const i=(y*png.width+x)*4;return [png.data[i],png.data[i+1],png.data[i+2]];};
    const bg=[1,3,5].map(i=>parseInt(background.slice(i,i+2),16));
    // The arrow occupies roughly 25-90 degrees (screen y down); it is judged by eye.
    const failing=[], arrow=a=>a>=25 && a<=90;
    let best=1;
    for(let a=0;a<360;a+=5) {
        let angle=1;
        for(let r=9;r<=15;r++) angle=Math.max(angle,contrast(at(Math.round(480+r*Math.cos(a*Math.PI/180)),Math.round(270+r*Math.sin(a*Math.PI/180))),bg));
        if(angle<3)failing.push(a); best=Math.max(best,angle);
    }
    return { ring_angles_at_3_to_1: 1-failing.length/72, outside_arrow_at_3_to_1: 1-failing.filter(a=>!arrow(a)).length/58,
        failing_angles: failing, best_contrast: Math.round(best*10)/10 };
}
async function sequence({ env, enginePath, args, dir, scale, width, height, background, screenshot, recorder, track=child=>child }) {
    mkdirSync(dir,{recursive:true});
    const phase=process.env.DESKLINK_INDICATOR_PHASE || 'after';
    const clip=join(dir,`desklink-agent-indicator-${phase}.mp4`);
    let helper, recording; const results={};
    try {
        await background(colors.dark,width/2,height/2);
        recording=track(recorder(clip),'ffmpeg');
        await sleep(300);
        helper=track(spawn(enginePath,args,{env,stdio:['pipe','pipe','pipe']}),enginePath);
        helper.stderr.on('data',b=>process.stderr.write(b));
        await ready(helper);
        for(const [name,color] of Object.entries(colors)) {
            await background(color,width/2,height/2);
            // Movement and settling, followed by click and typing feedback.
            for(let i=0;i<24;i++) {
                const x=width/2+(i-23)*8*scale,y=height/2;
                await background(color,x,y);
                helper.stdin.write(`M ${x} ${y}\n`);
                await sleep(25);
            }
            await sleep(250);
            const still=join(dir,`desklink-agent-indicator-${phase}-${name}-960x540.png`);
            await screenshot(still);
            results[name]=legibility(still,color);
            helper.stdin.write(`C ${width/2} ${height/2}\n`); await sleep(300);
            helper.stdin.write(`T ${width/2} ${height/2}\n`); await sleep(250);
        }
        helper.stdin.end('S\n');
        helper.exitCode ?? helper.signalCode ?? await Promise.race([new Promise(r=>helper.once('exit',r)),sleep(5000).then(()=>helper.kill('SIGKILL'))]);
        assert.equal(helper.exitCode,0,'indicator clean exit');
        await sleep(300);
    } finally {
        if(helper)await stop(helper);
        if(recording)await stop(recording,'SIGINT');
    }
    assert(existsSync(clip),'native clip exists');
    const probe=JSON.parse(run('ffprobe',['-v','error','-show_streams','-of','json',clip],env));
    assert.equal(probe.streams[0].width,width);assert.equal(probe.streams[0].height,height);
    writeFileSync(join(dir,`${phase}-provenance.json`),JSON.stringify({enginePath:resolve(enginePath),width,height,scale,clip,colors,legibility:results,display:env.DISPLAY,wayland:env.WAYLAND_DISPLAY},null,2));
    return results;
}
export async function recordX11({ env, enginePath, display, width, height, scale, verifyXvfb, remember }) {
    await verifyXvfb();
    run('python3',['-c',xfixture,'dpi',String(96*scale)],env);
    const dir=join(process.env.DESKLINK_INDICATOR_EVIDENCE_DIR,`x11-${scale}x`);
    const track=(child,label)=>{remember(child.pid,label);return child;};
    // Colours are painted by a full-screen demo app that sets its own text
    // cursor, as most real apps do; the root background never shows.
    const app=track(spawn('python3',['-c',xfixture,'appwin',String(width),String(height)],{env,stdio:['pipe','pipe','inherit']}),'python3');
    app.stdin.on('error',()=>{});
    try {
        await ready(app);
        await sequence({env,enginePath,args:['agent-overlay',display],dir,scale,width,height,track,
            background: async (color,x,y)=>{await verifyXvfb();app.stdin.write(color+'\n');run('python3',['-c',xfixture,color,String(Math.round(x)),String(Math.round(y))],env);},
            screenshot: async path=>{await verifyXvfb();run('ffmpeg',['-loglevel','error','-y','-f','x11grab','-draw_mouse','1','-video_size',`${width}x${height}`,'-i',display,'-frames:v','1','-vf','scale=960:540',path],env);},
            recorder: path=>spawn('ffmpeg',['-loglevel','error','-y','-f','x11grab','-draw_mouse','1','-framerate','30','-video_size',`${width}x${height}`,'-i',display,'-c:v','libx264','-preset','ultrafast','-crf','18',path],{env,stdio:['ignore','ignore','inherit']})});
    } finally { app.stdin.end(); await stop(app); }
}
// Demo fixture only: a full-screen solid-color application on the private socket.
const waylandFixture = `import os
os.environ['NO_AT_BRIDGE']='1'
import gi,sys,threading
gi.require_version('Gtk','3.0')
from gi.repository import Gtk,GLib
window=Gtk.Window();window.set_title('Umer');window.fullscreen()
area=Gtk.DrawingArea();window.add(area)
color=[0.06,0.09,0.12]
def draw(widget,cr):
 cr.set_source_rgb(*color);cr.paint()
area.connect('draw',draw)
def change(line):
 color[:]=[int(line[i:i+2],16)/255 for i in (1,3,5)];area.queue_draw()
def reader():
 for line in sys.stdin: GLib.idle_add(change,line.strip())
 GLib.idle_add(Gtk.main_quit)
threading.Thread(target=reader,daemon=True).start()
window.show_all();Gtk.main()
`;
export async function recordWayland() {
    assertNoAmbientDesktop();
    const root=process.env.DESKLINK_INDICATOR_EVIDENCE_DIR;
    assert(root,'set DESKLINK_INDICATOR_EVIDENCE_DIR');
    const enginePath=process.env.DESKLINK_AXI_ENGINE;assert(enginePath && existsSync(enginePath));
    const sway=process.env.DESKLINK_INDICATOR_SWAY;assert(sway && existsSync(sway),'set a headless-capable sway binary');
    const scale=process.env.DESKLINK_INDICATOR_SCALE==='2'?2:1,width=1920*scale,height=1080*scale;
    // A short private runtime keeps socket paths well under the sun_path limit.
    const dir=join(root,`wayland-${scale}x`),runtime=mkdtempSync(join(tmpdir(),'dl-indicator-'));
    mkdirSync(dir,{recursive:true});
    const config=join(runtime,'sway.conf');
    writeFileSync(config,`output HEADLESS-1 mode ${width}x${height}@60Hz scale ${scale} position 0 0\noutput HEADLESS-1 bg #101820 solid_color\nfont monospace 10\nswaybg_command -\nxwayland disable\n`);
    const ipc=join(runtime,'sway-ipc.sock');
    // sway only creates its IPC socket where SWAYSOCK names it; never inherit one.
    const env={...process.env,XDG_RUNTIME_DIR:runtime,WAYLAND_DISPLAY:'',DISPLAY:'',SWAYSOCK:ipc,DBUS_SESSION_BUS_ADDRESS:'unix:path=/nonexistent',DBUS_SYSTEM_BUS_ADDRESS:'unix:path=/nonexistent',WLR_BACKENDS:'headless',WLR_RENDERER:'pixman',WLR_LIBINPUT_NO_DEVICES:'1',XDG_CONFIG_HOME:runtime,NO_AT_BRIDGE:'1',GDK_BACKEND:'wayland'};
    let compositor, fixture;
    try {
        writeFileSync(join(dir,'sway.log'),'');
        compositor=spawn(sway,['-c',config],{env,stdio:['ignore','ignore','pipe']});
        compositor.stderr.on('data',b=>writeFileSync(join(dir,'sway.log'),b,{flag:'a'}));
        // A signal skips finally: still reap the compositor and fixture.
        for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{fixture?.kill('SIGKILL');compositor.kill('SIGKILL');rmSync(runtime,{recursive:true,force:true});process.exit(1);});
        for(let i=0;i<100 && !readdirSync(runtime).some(n=>/^wayland-\d+$/.test(n));i++) {assert.equal(compositor.exitCode,null,'private compositor exited');await sleep(50);}
        const socket=readdirSync(runtime).find(n=>/^wayland-\d+$/.test(n));assert(socket,'private Wayland socket');
        // Prove this PID holds both listening sockets before connecting any client.
        const owns=path=>readFileSync('/proc/net/unix','utf8').split('\n').filter(r=>r.endsWith(` ${path}`)).some(row=>
            readdirSync(`/proc/${compositor.pid}/fd`).some(fd=> {
                try{return readlinkSync(`/proc/${compositor.pid}/fd/${fd}`)===`socket:[${row.trim().split(/\s+/)[6]}]`;}catch{return false;}
            }));
        for(let i=0;i<100 && !existsSync(ipc);i++)await sleep(50);
        assert(owns(join(runtime,socket)),'private compositor Wayland socket ownership');
        assert(owns(ipc),'private compositor IPC socket ownership');
        env.WAYLAND_DISPLAY=socket;
        const swaymsg=join(resolve(sway,'..'),'swaymsg');
        const outputs=JSON.parse(run(swaymsg,['-t','get_outputs','-r'],env));
        assert.equal(outputs.length,1);assert.equal(outputs[0].name,'HEADLESS-1');assert.equal(outputs[0].scale,scale);
        fixture=spawn('python3',['-c',waylandFixture],{env,stdio:['pipe','ignore','inherit']});
        await sleep(600);
        await sequence({env,enginePath,args:['agent-overlay-wayland',String(width),String(height)],dir,scale,width,height,
            background: async color=>{fixture.stdin.write(color+'\n');await sleep(30);},
            screenshot: async path=>{
                const native=join(runtime,'native.png');run('grim',['-o','HEADLESS-1',native],env);
                run('ffmpeg',['-loglevel','error','-y','-i',native,'-vf','scale=960:540',path],env);
            },
            recorder: path=> {
                // Screencopy frames from grim, stamped with wall-clock time; SIGINT finalizes the file.
                const encoder=spawn('ffmpeg',['-loglevel','error','-y','-use_wallclock_as_timestamps','1','-f','image2pipe','-c:v','ppm','-i','-','-fps_mode','vfr','-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p',path],{env,stdio:['pipe','ignore','inherit']});
                encoder.stdin.on('error',()=>{}); // EPIPE once SIGINT stops the encoder.
                (async()=> {
                    while(encoder.exitCode===null && encoder.signalCode===null && encoder.stdin.writable) {
                        const frame=await new Promise(done=> {
                            const grim=spawn('grim',['-t','ppm','-o','HEADLESS-1','-'],{env,stdio:['ignore','pipe','ignore']}), parts=[];
                            grim.stdout.on('data',b=>parts.push(b)); grim.once('close',code=>done(code===0?Buffer.concat(parts):null));
                        });
                        if(frame && encoder.stdin.writable) await new Promise(done=>encoder.stdin.write(frame,done));
                    }
                })().catch(()=>{});
                return encoder;
            }});
    } finally {if(fixture)await stop(fixture);if(compositor)await stop(compositor);rmSync(runtime,{recursive:true,force:true});}
}
if(process.argv[1] && resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname))await recordWayland();
