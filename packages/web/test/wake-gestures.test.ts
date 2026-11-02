import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WAKE_GESTURES, WakeGestures, parseWakePreference, wakePreferenceKey, type WakeGestureId } from '../src/wake-gestures';

let adapter: WakeGestures;
let target: HTMLDivElement;
let enabled: WakeGestureId[];
let allowed: boolean;
let trigger: ReturnType<typeof vi.fn>;
let hint: ReturnType<typeof vi.fn>;
const point = (identifier:number, x=100+identifier*30,y=250,targetNode:EventTarget=target) => new Touch({identifier,target:targetNode,clientX:x,clientY:y});
function touch(type:string,active:Touch[],changed=active,element:EventTarget=target): TouchEvent {
  const event=new TouchEvent(type,{bubbles:true,cancelable:true,composed:true,touches:active,changedTouches:changed});
  element.dispatchEvent(event); return event;
}
function tap(x=100,y=250) {
  const a=point(1,x,y),b=point(2,x+30,y);
  touch('touchstart',[a,b]); vi.advanceTimersByTime(40); touch('touchend',[],[a,b]);
}
beforeEach(()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
  target=document.createElement('div'); document.body.append(target);
  enabled=WAKE_GESTURES.map(g=>g.id); allowed=true; trigger=vi.fn(); hint=vi.fn();
  adapter=new WakeGestures({enabled:()=>enabled,allowed:()=>allowed,excluded:()=>false,hint,trigger}); adapter.connect();
});
afterEach(()=>{adapter.disconnect(); document.body.innerHTML=''; vi.useRealTimers(); vi.restoreAllMocks();});

describe('native touch wake recognition',()=>{
  it('two fingers hold for 700ms from the second contact, latch once and wait for every up',()=>{
    const a=point(1), b=point(2);
    expect(touch('touchstart',[a]).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(180); // inclusive joining boundary
    expect(touch('touchstart',[a,b],[b]).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(699); expect(hint).not.toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(1); expect(hint).toHaveBeenLastCalledWith(true); expect(trigger).not.toHaveBeenCalled();
    touch('touchend',[b],[a]); expect(trigger).not.toHaveBeenCalled();
    touch('touchend',[],[b]); expect(trigger).toHaveBeenCalledExactlyOnceWith({x:145,y:250});
    touch('touchend',[],[b]); expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('three fingers arriving before scroll reserve only their own sequence and use the final centroid',()=>{
    const a=point(1),b=point(2),c=point(3);
    expect(touch('touchstart',[a]).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(30); expect(touch('touchstart',[a,b],[b]).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(30); expect(touch('touchstart',[a,b,c],[c]).defaultPrevented).toBe(true);
    const up=[point(1,135,175),point(2,165,170),point(3,195,160)];
    expect(touch('touchmove',up).defaultPrevented).toBe(true);
    expect(hint).toHaveBeenLastCalledWith(true); expect(trigger).not.toHaveBeenCalled();
    touch('touchend',[],up); expect(trigger).toHaveBeenCalledExactlyOnceWith({x:165,y:505/3});
  });
  it('two-finger double tap requires two contacts in both rounds; round gap is measured at the next down',()=>{
    enabled=['two-finger-double-tap'];
    tap(); vi.advanceTimersByTime(290); tap(110,255);
    expect(trigger).toHaveBeenCalledExactlyOnceWith({x:125,y:255});
    vi.advanceTimersByTime(1000);
    const a=point(1); touch('touchstart',[a]); touch('touchend',[],[a]);
    touch('touchstart',[a]); touch('touchend',[],[a]); expect(trigger).toHaveBeenCalledTimes(1);
  });
  it.each(['early up','late join','move','pinch','third finger','cancel'] as const)('hold rejects %s without preventing host pinch',kind=>{
    const a=point(1),b=point(2);
    touch('touchstart',[a]);
    if(kind==='late join') vi.advanceTimersByTime(181);
    touch('touchstart',[a,b],[b]);
    if(kind==='early up') {vi.advanceTimersByTime(699); touch('touchend',[],[a,b]);}
    if(kind==='move') expect(touch('touchmove',[point(1,150),b]).defaultPrevented).toBe(false);
    if(kind==='pinch') expect(touch('touchmove',[point(1,80),point(2,210)]).defaultPrevented).toBe(false);
    if(kind==='third finger') { enabled=['two-finger-hold']; touch('touchstart',[a,b,point(3)],[point(3)]); }
    if(kind==='cancel') touch('touchcancel',[],[a,b]);
    vi.advanceTimersByTime(1000); touch('touchend',[],[a,b]); expect(trigger).not.toHaveBeenCalled(); expect(hint).not.toHaveBeenCalledWith(true);
  });
  it('evaluates the lateral ratio at recognition, allowing an initially shallow upward path within the fixed bounds',()=>{
    enabled=['three-finger-swipe-up']; touch('touchstart',[point(1),point(2),point(3)]);
    touch('touchmove',[point(1,145,245),point(2,175,245),point(3,205,245)]);
    const moved=[point(1,150,150),point(2,180,150),point(3,210,150)];
    touch('touchmove',moved); touch('touchend',[],moved); expect(trigger).toHaveBeenCalledExactlyOnceWith({x:180,y:150});
  });
  it('cannot reserve a non-cancelable third contact after the browser has already won scrolling',()=>{
    enabled=['three-finger-swipe-up'];
    const ps=[point(1),point(2),point(3)];
    target.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,cancelable:false,touches:ps,changedTouches:ps}));
    const moved=[point(1,130,150),point(2,160,150),point(3,190,150)];
    touch('touchmove',moved); touch('touchend',[],moved); expect(trigger).not.toHaveBeenCalled();
  });
  it('swipe starts measuring after all three arrive; pre-join drift cannot satisfy the threshold',()=>{
    enabled=['three-finger-swipe-up']; const a=point(1),b=point(2),c=point(3);
    touch('touchstart',[a,b]); touch('touchmove',[point(1,130,240),point(2,160,240)]);
    touch('touchstart',[point(1,130,240),point(2,160,240),c],[c]);
    const short=[point(1,130,175),point(2,160,175),point(3,190,175)];
    touch('touchmove',short); expect(hint).not.toHaveBeenCalledWith(true); touch('touchend',[],short); expect(trigger).not.toHaveBeenCalled();
  });
  it('a small opposing two-finger pinch is rejected even if each finger remains inside its own tolerance',()=>{
    enabled=['two-finger-hold']; touch('touchstart',[point(1),point(2)]);
    expect(touch('touchmove',[point(1,123),point(2,167)]).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(700); touch('touchend',[],[point(1,123),point(2,167)]); expect(trigger).not.toHaveBeenCalled();
  });
  it.each(['down','sideways','one stationary','four fingers','timeout','pre-move','host scroll'] as const)('swipe rejects %s',kind=>{
    enabled=['three-finger-swipe-up']; const a=point(1),b=point(2),c=point(3);
    touch('touchstart',[a,b]);
    if(kind==='pre-move') touch('touchmove',[point(1,150),b]);
    if(kind==='host scroll') window.dispatchEvent(new Event('scroll'));
    touch('touchstart',[a,b,c],[c]);
    if(kind==='timeout') vi.advanceTimersByTime(701);
    if(kind==='four fingers') touch('touchstart',[a,b,c,point(4)],[point(4)]);
    const moved=[1,2,3].map(id=>point(id,100+id*30+(kind==='sideways'?70:0),kind==='down'?330:kind==='one stationary'&&id===1?250:160));
    touch('touchmove',moved); touch('touchend',[],moved); expect(trigger).not.toHaveBeenCalled();
  });
  it.each(['slow tap','slow joins','slow releases','gap','distance','cancel'] as const)('double tap rejects %s',kind=>{
    enabled=['two-finger-double-tap']; tap();
    if(kind==='gap') vi.advanceTimersByTime(301);
    if(kind==='distance') { tap(200); expect(trigger).not.toHaveBeenCalled(); return; }
    const a=point(1),b=point(2); touch('touchstart',[a]);
    vi.advanceTimersByTime(kind==='slow joins'?121:20); touch('touchstart',[a,b],[b]);
    if(kind==='slow tap') vi.advanceTimersByTime(221);
    if(kind==='cancel') touch('touchcancel',[],[a,b]);
    touch('touchend',[b],[a]);
    vi.advanceTimersByTime(kind==='slow releases'?101:10); touch('touchend',[],[b]);
    expect(trigger).not.toHaveBeenCalled();
  });
  it('single finger scroll, disabled and unavailable gestures never reserve or trigger',()=>{
    const a=point(1),b=point(2);
    expect(touch('touchstart',[a]).defaultPrevented).toBe(false);
    expect(touch('touchmove',[point(1,100,80)]).defaultPrevented).toBe(false);
    touch('touchend',[],[a]); enabled=[];
    expect(touch('touchstart',[a,b]).defaultPrevented).toBe(false); vi.advanceTimersByTime(1000); touch('touchend',[],[a,b]);
    enabled=['two-finger-hold']; allowed=false;
    touch('touchstart',[a,b]); vi.advanceTimersByTime(1000); touch('touchend',[],[a,b]); expect(trigger).not.toHaveBeenCalled();
  });
  it.each(['cancel','extra finger','invalidate','disconnect'] as const)('a latched result is cancelled by %s before release',kind=>{
    enabled=['two-finger-hold']; const a=point(1),b=point(2); touch('touchstart',[a,b]); vi.advanceTimersByTime(700);
    if(kind==='cancel') touch('touchcancel',[],[a,b]);
    if(kind==='extra finger') touch('touchstart',[a,b,point(3)],[point(3)]);
    if(kind==='invalidate') { allowed=false; adapter.reset(); }
    if(kind==='disconnect') adapter.disconnect();
    touch('touchend',[],[a,b]); expect(trigger).not.toHaveBeenCalled();
  });
  it('only suppresses the successful sequence touch-generated click, keeps mouse click and expires',()=>{
    enabled=['two-finger-double-tap']; tap(); tap();
    const mouse=new MouseEvent('click',{bubbles:true,cancelable:true,clientX:115,clientY:250}); target.dispatchEvent(mouse); expect(mouse.defaultPrevented).toBe(false);
    const click=new PointerEvent('click',{pointerType:'touch',bubbles:true,cancelable:true,clientX:115,clientY:250}); target.dispatchEvent(click); expect(click.defaultPrevented).toBe(true);
    const next=new PointerEvent('click',{pointerType:'touch',bubbles:true,cancelable:true,clientX:115,clientY:250}); target.dispatchEvent(next); expect(next.defaultPrevented).toBe(false);
    tap(); tap(); vi.advanceTimersByTime(801); target.dispatchEvent(next); expect(next.defaultPrevented).toBe(false);
  });
});

describe('wake preferences',()=>{
  it('filters duplicates, unknown IDs, malformed input and unsupported versions',()=>{
    expect(wakePreferenceKey('com/a b')).toBe('feedback:wake-gestures:v1:com%2Fa%20b');
    expect(parseWakePreference('{"version":1,"enabled":["two-finger-hold","unknown","two-finger-hold"]}')).toEqual(['two-finger-hold']);
    for(const raw of [null,'invalid','{"version":2,"enabled":["two-finger-hold"]}','{"version":1,"enabled":false}']) expect(parseWakePreference(raw)).toEqual([]);
  });
});
