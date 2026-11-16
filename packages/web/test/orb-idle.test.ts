import { setTimeout as nextTask } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { OrbLens } from '../src/orb-lens';
import { orbIdlePreferenceKey, parseOrbIdlePreference } from '../src/orb-idle';
import { STYLES } from '../src/styles';
import { APP_ID, cleanup, mount as mountBase, type Mounted } from './helpers';
import { WAKE_GESTURES, wakePreferenceKey, type WakeGestureId } from '../src/wake-gestures';
import { blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';

vi.mock('../src/capture',async original => ({...await original<typeof import('../src/capture')>(),captureViewport:vi.fn(async()=>{throw new Error('fixture: no safe texture');})}));
const mount = (attributes:Record<string,string>={}) => mountBase({'launcher-mode':'orb',...attributes});
const collapsed = (m:Mounted) => m.orb.classList.contains('is-collapsed');
const radio = (m:Mounted,style='edge') => m.root.querySelector<HTMLInputElement>(`[data-orb-idle="${style}"]`)!;
const settings = (m:Mounted) => {m.widget.open(); m.root.querySelector<HTMLButtonElement>('.fb-settings-btn')!.click();};
const pointer = (m:Mounted,type:string,x=100,y=100) => m.orb.dispatchEvent(new PointerEvent(type,{bubbles:true,composed:true,button:0,isPrimary:true,pointerId:1,clientX:x,clientY:y}));
const key = (target:EventTarget,value:string) => target.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,composed:true,cancelable:true}));
function safeProvider(m:Mounted) {
  stubCreateElementCanvas(createState());
  vi.stubGlobal('createImageBitmap',async (blob:Blob)=>({...await blobToPng(blob),close:vi.fn()}));
  const capture=vi.fn(async()=>({blob:new Blob([encodePng(400,300,new Uint8ClampedArray(400*300*4).fill(255))],{type:'image/png'}),width:400,height:300,viewport:{width:400,height:300}}));
  m.widget.captureProvider=capture; return capture;
}
function requireVisibleFocusTarget(m:Mounted) {
  const focus=m.orb.focus.bind(m.orb);
  vi.spyOn(m.orb,'focus').mockImplementation(options=>{
    // happy-dom will focus display:none; real browsers reject that focus target.
    expect(getComputedStyle(m.orb).display).not.toBe('none');
    expect(m.orb.classList.contains('is-unavailable')).toBe(false);
    focus(options);
  });
}
// happy-dom's observer uses its Window's real task queue, separate from fake idle time.
async function settle() { await nextTask(0); await vi.advanceTimersByTimeAsync(0); }

// 唤醒手势模拟（与 wake-flow.test.ts 相同的 TouchEvent helper）。
const idleHidden = (m:Mounted) => m.orb.classList.contains('is-idle-hidden');
let host: HTMLDivElement;
const enableGestures = (ids:readonly WakeGestureId[] = WAKE_GESTURES.map(g=>g.id)) =>
  localStorage.setItem(wakePreferenceKey(APP_ID),JSON.stringify({version:1,enabled:ids}));
const points = (y=200) => [new Touch({identifier:1,target:host,clientX:120,clientY:y}),new Touch({identifier:2,target:host,clientX:160,clientY:y})];
function touch(type:string,active:Touch[],changed=active,target:EventTarget=host) {
  const event=new TouchEvent(type,{bubbles:true,cancelable:true,composed:true,touches:active,changedTouches:changed}); target.dispatchEvent(event); return event;
}
function holdStart() { touch('touchstart',points()); }
function release() { touch('touchend',[],points()); }
function hold() { holdStart(); vi.advanceTimersByTime(700); release(); }

beforeEach(()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
  vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  vi.spyOn(OrbLens,'create').mockReturnValue(null);
});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('local idle style preference',()=>{
  it.each([null,'bad','{}','{"version":0,"style":"edge"}','{"version":1,"style":"unknown"}'])('invalid %s uses handle',value=>{
    expect(parseOrbIdlePreference(value)).toBe('handle');
  });
  it('restores at root, saves independently and preserves the new selection across reconnect, service and app changes',()=>{
    localStorage.setItem(orbIdlePreferenceKey(APP_ID),JSON.stringify({version:1,style:'edge'}));
    localStorage.setItem(wakePreferenceKey(APP_ID),'wake sentinel');
    const m=mount(); expect(radio(m).checked).toBe(true);
    settings(m); radio(m,'handle').click(); radio(m).click();
    expect(JSON.parse(localStorage.getItem(orbIdlePreferenceKey(APP_ID))!)).toEqual({version:1,style:'edge'});
    expect(localStorage.getItem(wakePreferenceKey(APP_ID))).toBe('wake sentinel');
    m.widget.close(); m.widget.apiBase='http://other-api.test'; expect(radio(m).checked).toBe(true);
    m.widget.appId='other app'; expect(radio(m,'handle').checked).toBe(true);
    settings(m); radio(m).click();
    expect(localStorage.getItem('feedback:orb-idle:v1:other%20app')).toContain('edge');
    m.widget.appId=APP_ID; expect(radio(m).checked).toBe(true);
    m.widget.remove(); document.body.append(m.widget); expect(radio(m).checked).toBe(true);
  });
  it('write failure keeps this instance effective and reconnect cannot overwrite the newer choice',()=>{
    const m=mount(); settings(m);
    vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('storage blocked');});
    radio(m).click(); expect(radio(m).checked).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-orb-idle-pref-hint')!.hidden).toBe(false);
    m.widget.remove(); document.body.append(m.widget); expect(radio(m).checked).toBe(true);
  });
  it('read failure defaults safely; a later synchronous edit wins without delayed restoration',()=>{
    vi.spyOn(localStorage,'getItem').mockImplementation(()=>{throw new Error('storage blocked');});
    const m=mount(); expect(radio(m,'handle').checked).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-orb-idle-pref-hint')!.hidden).toBe(false);
    settings(m); radio(m).click(); expect(radio(m).checked).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-orb-idle-pref-hint')!.hidden).toBe(true);
  });
});

describe('idle launcher timing, hit surface and activation',()=>{
  it('R7 starts with a56px mist ball, collapses only after5000ms to a44×56 hit surface and complete12×56 capsule, then click only wakes',async()=>{
    const m=mount({'capture-mode':'viewport'}),provider=vi.fn(()=>new Promise<never>(()=>{})); m.widget.captureProvider=provider;
    expect(collapsed(m)).toBe(false); expect(getComputedStyle(m.orb).width).toBe('56px');
    expect(m.root.querySelector('.fb-orb-idle-icon')).toBeNull();
    vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true);
    expect(getComputedStyle(m.orb).width).toBe('44px'); expect(getComputedStyle(m.orb).height).toBe('56px');
    // R7 replaces the opaque12×48 CSS handle with a sampled12×56 capsule.
    const path=m.root.querySelector<SVGPathElement>('svg.fb-orb-lens path')!;
    const coords=[...path.getAttribute('d')!.matchAll(/([\d.e+-]+),([\d.e+-]+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
    const width=Math.max(...coords.map(p=>p[0]!))-Math.min(...coords.map(p=>p[0]!));
    const height=Math.max(...coords.map(p=>p[1]!))-Math.min(...coords.map(p=>p[1]!));
    expect(width).toBeCloseTo(12,4); expect(height).toBeCloseTo(56,4);
    expect(path.getAttribute('fill')).toBe('none');
    expect(m.orb.getAttribute('aria-label')).toBe('唤醒灵感球');
    expect(m.root.querySelector<HTMLCanvasElement>('canvas.fb-orb-lens')!.hidden).toBe(true);
    expect(m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!.style.display).toBe('');
    pointer(m,'pointerdown'); pointer(m,'pointerup'); m.orb.click(); await settle();
    expect(collapsed(m)).toBe(false); expect(provider).not.toHaveBeenCalled(); expect(m.panel.classList.contains('is-open')).toBe(false);
    pointer(m,'pointerdown'); pointer(m,'pointerup'); expect(provider).toHaveBeenCalledTimes(1);
  });
  it('Tab focus restores the ball and keeps it available; full-ball Enter keeps the original panel action',()=>{
    const m=mount(); vi.advanceTimersByTime(5000); expect(collapsed(m)).toBe(true);
    key(document,'Tab');
    m.orb.focus(); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(10000); expect(collapsed(m)).toBe(false);
    m.orb.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    expect(m.panel.classList.contains('is-open')).toBe(true);
    m.widget.close(); expect(collapsed(m)).toBe(false);
    m.orb.blur(); vi.advanceTimersByTime(5000); expect(collapsed(m)).toBe(true);
  });
  it('hover and held pointer pause idle; cancel resumes a fresh interval',()=>{
    const m=mount();
    m.orb.dispatchEvent(new PointerEvent('pointerenter')); vi.advanceTimersByTime(9000); expect(collapsed(m)).toBe(false);
    m.orb.dispatchEvent(new PointerEvent('pointerleave')); vi.advanceTimersByTime(4000);
    pointer(m,'pointerdown'); vi.advanceTimersByTime(9000); expect(collapsed(m)).toBe(false);
    pointer(m,'pointercancel'); vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true);
  });
  it.each(['left','right'])('%s edge style moves both the 44px hit layer and independent lens to the same safe edge',async side=>{
    localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"edge"}');
    const draw=vi.fn(),dispose=vi.fn();
    vi.mocked(OrbLens.create).mockReturnValue({draw,dispose,clearImage:vi.fn(),setImage:vi.fn()} as unknown as OrbLens);
    const m=mount({side});
    // Ignore a stale DOM rect: the independent hit/canvas layers share the morph state.
    vi.spyOn(m.orb,'getBoundingClientRect').mockReturnValue(new DOMRect(side==='left'?20:948,200,56,56));
    m.orb.dispatchEvent(new PointerEvent('pointerenter')); m.orb.dispatchEvent(new PointerEvent('pointerleave'));
    vi.advanceTimersByTime(5000); await settle(); expect(collapsed(m)).toBe(true);
    expect(draw.mock.calls.at(-1)![0]).toEqual({x:side==='left'?0:1024,y:228});
    expect(getComputedStyle(m.orb).width).toBe('44px');
    const canvas=m.root.querySelector<HTMLCanvasElement>('canvas.fb-orb-lens')!;
    expect(canvas.hidden).toBe(false);
    expect(canvas.style.clipPath).toBe(side==='left'?'inset(0 0% 0 50%)':'inset(0 50% 0 0%)');
    m.orb.click(); expect(collapsed(m)).toBe(false); expect(draw.mock.calls.at(-1)![0]).toEqual({x:side==='left'?48:976,y:228});
    expect(canvas.style.clipPath).toBe('inset(0 0% 0 0%)');
  });
  it.each(['panel','capture','selection'])('%s keeps the entry from collapsing, then restores the full safe launcher',async state=>{
    const m=mount();
    if(state==='panel') m.widget.open();
    else {
      if (state==='selection') {
        stubCreateElementCanvas(createState());
        vi.stubGlobal('createImageBitmap',async (blob:Blob)=>({...await blobToPng(blob),close:vi.fn()}));
        m.widget.captureProvider=vi.fn(async()=>({blob:new Blob([encodePng(400,300,new Uint8ClampedArray(400*300*4).fill(255))],{type:'image/png'}),width:400,height:300,viewport:{width:400,height:300}}));
      } else m.widget.captureProvider=vi.fn(()=>new Promise<never>(()=>{}));
      pointer(m,'pointerdown'); pointer(m,'pointermove',200,200); pointer(m,'pointerup',200,200);
      await settle();
      expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(state!=='selection');
    }
    vi.advanceTimersByTime(9000); expect(collapsed(m)).toBe(false);
    m.widget.close(); await settle(); expect(collapsed(m)).toBe(false);
  });
});

describe('R5 input modality and returned focus (no manual blur)',()=>{
  it.each(['panel','selection'])('pointer %s dismissal returns focus but starts a fresh5000ms idle interval',async state=>{
    const m=mount();
    if(state==='panel') {pointer(m,'pointerdown'); pointer(m,'pointerup');}
    else {safeProvider(m); pointer(m,'pointerdown'); pointer(m,'pointermove',200,200); pointer(m,'pointerup',200,200); await settle(); expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(false);}
    requireVisibleFocusTarget(m);
    const button=m.root.querySelector<HTMLButtonElement>(state==='panel'?'.fb-close':'.fb-region-cancel')!;
    button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,button:0,pointerType:'mouse'})); button.click();
    m.orb.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));
    await settle(); expect(m.root.activeElement).toBe(m.orb);
    vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true); expect(m.root.activeElement).toBe(m.orb);
    pointer(m,'pointerdown'); pointer(m,'pointerup'); m.orb.click();
    expect(collapsed(m)).toBe(false); expect(m.panel.classList.contains('is-open')).toBe(false);
    vi.advanceTimersByTime(5000); expect(collapsed(m)).toBe(true);
  });
  it.each(['panel','selection'])('keyboard %s dismissal preserves keyboard focus and pauses idle until pointer input',async state=>{
    const m=mount();
    if(state==='selection') {safeProvider(m); pointer(m,'pointerdown'); pointer(m,'pointermove',200,200); pointer(m,'pointerup',200,200); await settle();}
    else {key(document,'Tab'); m.orb.focus(); key(m.orb,'Enter');}
    requireVisibleFocusTarget(m);
    key(state==='panel'?m.textarea:m.root.querySelector('.fb-region-frame')!,'Escape');
    await settle(); expect(m.root.activeElement).toBe(m.orb);
    vi.advanceTimersByTime(9000); expect(collapsed(m)).toBe(false);
    document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));
    vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true);
  });
  it('touch handle activation only wakes and touch focus/enter cannot hold the launcher open',async()=>{
    const m=mount({'capture-mode':'viewport'}),capture=safeProvider(m);
    vi.advanceTimersByTime(5000); expect(collapsed(m)).toBe(true);
    m.orb.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'touch'}));
    m.orb.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',bubbles:true,composed:true,button:0,isPrimary:true,pointerId:5}));
    m.orb.focus();
    m.orb.dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',bubbles:true,composed:true,button:0,pointerId:5}));
    m.orb.click(); await settle(); expect(capture).not.toHaveBeenCalled(); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true); expect(m.root.activeElement).toBe(m.orb);
  });
});

describe('idle generation and host lifecycle',()=>{
  it.each(['show','mode','app','server','page','hidden','inert','disabled','background','pagehide','detach'])('%s makes the old idle callback harmless and a restored launcher starts a new interval',async action=>{
    const timer=vi.spyOn(globalThis,'setTimeout');
    const m=mount();
    const old=timer.mock.calls.find(call=>call[1]===5000)![0] as ()=>void;
    vi.advanceTimersByTime(4000);
    if(action==='show') m.widget.showLauncher=false;
    if(action==='mode') m.widget.launcherMode='tab';
    if(action==='app') m.widget.appId='next';
    if(action==='server') m.widget.apiBase='http://next-api.test';
    if(action==='page') m.widget.pageLabel='next page';
    if(action==='hidden') m.widget.hidden=true;
    if(action==='inert') m.widget.setAttribute('inert','');
    if(action==='disabled') m.widget.setAttribute('aria-disabled','true');
    if(action==='background') {vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));}
    if(action==='pagehide') window.dispatchEvent(new Event('pagehide'));
    if(action==='detach') m.widget.remove();
    await settle(); old(); expect(collapsed(m)).toBe(false);
    if(action==='show') m.widget.showLauncher=true;
    if(action==='mode') m.widget.launcherMode='orb';
    if(action==='hidden') m.widget.hidden=false;
    if(action==='inert') m.widget.removeAttribute('inert');
    if(action==='disabled') m.widget.removeAttribute('aria-disabled');
    if(action==='background') {vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));}
    if(action==='pagehide') window.dispatchEvent(new Event('pageshow'));
    if(action==='detach') document.body.append(m.widget);
    await settle(); old(); vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true);
  });
  it('disabling during a held drag invalidates the old pointer even after the launcher returns',()=>{
    const m=mount({'capture-mode':'viewport'}),provider=vi.fn(()=>new Promise<never>(()=>{})); m.widget.captureProvider=provider;
    pointer(m,'pointerdown'); pointer(m,'pointermove',200,200);
    m.widget.showLauncher=false;
    expect(m.orb.classList.contains('is-unavailable')).toBe(true);
    m.widget.showLauncher=true;
    pointer(m,'pointerup',200,200);
    expect(provider).not.toHaveBeenCalled(); expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(m.orb.classList.contains('is-dragging')).toBe(false);
  });
  it('ancestor display/hidden transitions invalidate idle and reinitialize only when the host is usable',async()=>{
    const m=mount(),parent=document.createElement('div'); document.body.append(parent); parent.append(m.widget);
    vi.advanceTimersByTime(4000); parent.hidden=true; await settle();
    vi.advanceTimersByTime(9000); expect(collapsed(m)).toBe(false);
    parent.hidden=false; await settle();
    vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true);
    parent.style.display='none'; await settle(); expect(collapsed(m)).toBe(false);
  });
});

describe('R11 dark no-WebGL fallback',()=>{
  it('uses a clear tint and local thin reflection, then restores light and clear drag',async()=>{
    const m=mount({theme:'dark'}),outline=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!;
    const art=outline.querySelector('g')!,body=art.querySelector('path')!;
    const gradient=outline.querySelector('linearGradient')!;
    expect(gradient).not.toBeNull();
    expect(body.getAttribute('fill')).toBe('rgb(132,137,153)');
    expect(Number(body.getAttribute('fill-opacity'))).toBeCloseTo(.016,12);
    expect(body.getAttribute('stroke')).toBe(`url(#${gradient.id})`);
    expect(body.getAttribute('stroke-width')).toBe('1');
    expect(outline.style.filter).toBe('none');
    vi.advanceTimersByTime(5000);
    expect(Number(body.getAttribute('fill-opacity'))).toBeCloseTo(.042,12);
    m.widget.setAttribute('theme','light'); await settle();
    expect(body.getAttribute('fill')).toBe('none');
    m.widget.setAttribute('theme','dark'); await settle();
    m.orb.click(); pointer(m,'pointerdown'); pointer(m,'pointermove',160,100);
    expect(m.orb.classList.contains('is-dragging')).toBe(true);
    expect(body.getAttribute('fill')).toBe('none');
  });
  it.each(['left','right'])('%s dark handle is10×48 and10px from the safe edge; live theme changes retain collapse and hit size',async side=>{
    const m=mount({theme:'dark',side}),outline=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!;
    const path=outline.querySelector('g path')!;
    const size=()=>{
      const points=[...path.getAttribute('d')!.matchAll(/([\d.e+-]+),([\d.e+-]+)/g)].map(match=>[Number(match[1]),Number(match[2])]);
      return {width:Math.max(...points.map(p=>p[0]!))-Math.min(...points.map(p=>p[0]!)),height:Math.max(...points.map(p=>p[1]!))-Math.min(...points.map(p=>p[1]!))};
    };
    vi.advanceTimersByTime(5000);
    expect(collapsed(m)).toBe(true);
    expect(size().width).toBeCloseTo(10,4); expect(size().height).toBeCloseTo(48,4);
    const center=parseFloat(outline.style.left)+28*1.6;
    expect(side==='left'?center-5:1024-center-5).toBeCloseTo(10,8);
    expect(getComputedStyle(m.orb).width).toBe('44px'); expect(getComputedStyle(m.orb).height).toBe('56px');
    m.widget.setAttribute('theme','light'); await settle();
    expect(collapsed(m)).toBe(true); expect(size().width).toBeCloseTo(12,4); expect(size().height).toBeCloseTo(56,4);
    m.widget.setAttribute('theme','dark'); await settle();
    expect(collapsed(m)).toBe(true); expect(size().width).toBeCloseTo(10,4); expect(size().height).toBeCloseTo(48,4);
    m.orb.click(); expect(collapsed(m)).toBe(false); expect(size().width).toBeCloseTo(56,4);
    vi.advanceTimersByTime(3000); m.widget.setAttribute('theme','light'); await settle();
    vi.advanceTimersByTime(1999); expect(collapsed(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(collapsed(m)).toBe(true);
  });
});

describe('R7 finite continuous glass morph',()=>{
  it('light fallback clips only the outside after blur through capsule geometry, and removes clipping for dark or drag',async()=>{
    const m=mount({theme:'light'}),outline=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!;
    const art=outline.querySelector('g')!;
    const clip=outline.querySelector('clipPath')!;
    expect(clip).not.toBeNull();
    expect(clip.getAttribute('clipPathUnits')).toBe('userSpaceOnUse');
    const exterior=clip.querySelector('path')!;
    expect(exterior.getAttribute('clip-rule')).toBe('evenodd');
    const verify=()=>{
      const paths=art.querySelectorAll('path');
      expect(paths).toHaveLength(2);
      expect(art.getAttribute('clip-path')).toBe(`url(#${clip.id})`);
      expect(exterior.getAttribute('d')!.endsWith(paths[0]!.getAttribute('d')!)).toBe(true);
      expect(paths[1]!.getAttribute('d')).toBe(paths[0]!.getAttribute('d'));
    };
    verify();
    const initial=exterior.getAttribute('d');
    vi.advanceTimersByTime(5000); verify();
    expect(exterior.getAttribute('d')).not.toBe(initial);
    m.widget.setAttribute('theme','dark'); await settle();
    expect(art.hasAttribute('clip-path')).toBe(false);
    m.widget.setAttribute('theme','light'); await settle(); verify();
    m.orb.click(); pointer(m,'pointerdown'); pointer(m,'pointermove',160,100);
    expect(m.orb.classList.contains('is-dragging')).toBe(true);
    expect(art.hasAttribute('clip-path')).toBe(false);
  });
  it.each(['adopt','drop'])('%s session invalidates the current morph and allows a fresh finite idle cycle',async action=>{
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<never>(()=>{})));
    vi.stubGlobal('matchMedia',(media:string)=>({matches:false,media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    let id=0; const frames=new Map<number,FrameRequestCallback>(),draw=vi.fn();
    vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frames.set(++id,callback);return id;});
    vi.spyOn(window,'cancelAnimationFrame').mockImplementation(key=>{frames.delete(key);});
    vi.mocked(OrbLens.create).mockReturnValue({draw,dispose:vi.fn(),clearImage:vi.fn(),setImage:vi.fn()} as unknown as OrbLens);
    const m=mount();
    if(action==='drop') m.widget.adoptSession({accessToken:'fixture-old',expiresAt:1000000});
    const step=(time:number)=>{vi.setSystemTime(time);const batch=[...frames.values()];frames.clear();for(const callback of batch) callback(time);};
    vi.advanceTimersByTime(5000);step(5210);const stale=[...frames.values()]; expect(frames.size).toBe(1);
    if(action==='adopt') m.widget.adoptSession({accessToken:'fixture-new',expiresAt:1000000});
    else m.widget.dropSession();
    expect(collapsed(m)).toBe(false); expect(frames.size).toBe(0);
    await settle(); // invalidation restores a new GPU owner in the queued visibility check
    expect(draw.mock.calls.at(-1)![5].halfSize).toEqual({x:28,y:28});
    const count=draw.mock.calls.length;for(const callback of stale) callback(6000);expect(draw).toHaveBeenCalledTimes(count);
    vi.advanceTimersByTime(5000);step(Date.now()+420);
    expect(collapsed(m)).toBe(true);expect(draw.mock.calls.at(-1)![5].halfSize).toEqual({x:6,y:28});expect(frames.size).toBe(0);
  });
  it.each(['left','right'])('%s hemisphere moves and clips continuously; enabling reduced motion finishes and cancels its stale frame',side=>{
    const motion=Object.assign(new EventTarget(),{matches:false,media:'(prefers-reduced-motion: reduce)'});
    vi.stubGlobal('matchMedia',(media:string)=>media===motion.media?motion:{matches:false,media,addEventListener:vi.fn(),removeEventListener:vi.fn()});
    localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"edge"}');
    let id=0; const frames=new Map<number,FrameRequestCallback>(),draw=vi.fn();
    vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frames.set(++id,callback);return id;});
    vi.spyOn(window,'cancelAnimationFrame').mockImplementation(key=>{frames.delete(key);});
    vi.mocked(OrbLens.create).mockReturnValue({draw,dispose:vi.fn(),clearImage:vi.fn(),setImage:vi.fn()} as unknown as OrbLens);
    const m=mount({side}); vi.advanceTimersByTime(5000);
    vi.setSystemTime(5210); const batch=[...frames.values()]; frames.clear(); for(const callback of batch) callback(5210);
    const canvas=m.root.querySelector<HTMLCanvasElement>('canvas.fb-orb-lens')!;
    expect(draw.mock.calls.at(-1)![0].x).toBe(side==='left'?6:1018);
    expect(canvas.style.clipPath).toBe(side==='left'?'inset(0 0% 0 43.75%)':'inset(0 43.75% 0 0%)');
    expect(parseFloat(m.orb.style.width)).toBe(45.5);
    const stale=[...frames.values()]; motion.matches=true; motion.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0); expect(draw.mock.calls.at(-1)![0].x).toBe(side==='left'?0:1024);
    expect(parseFloat(m.orb.style.width)).toBe(44); expect(parseFloat(m.orb.style.left)).toBe(side==='left'?0:980);
    const count=draw.mock.calls.length; for(const callback of stale) callback(6000); expect(draw).toHaveBeenCalledTimes(count);
    m.orb.click(); expect(draw.mock.calls.at(-1)![0].x).toBe(side==='left'?48:976);
    expect(canvas.style.clipPath).toBe('inset(0 0% 0 0%)'); expect(frames.size).toBe(0);
  });
  it.each(['left','right'])('%s forced-colors capsule stays transparent and visible, but no fallback survives a hidden launcher',async side=>{
    vi.stubGlobal('matchMedia',(media:string)=>({matches:['(forced-colors: active)','(prefers-reduced-motion: reduce)'].includes(media),media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    const m=mount({side}),outline=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!;
    vi.advanceTimersByTime(5000);
    const path=outline.querySelector('path')!;
    expect(path.getAttribute('fill')).toBe('none'); expect(path.getAttribute('stroke')).toBe('ButtonText');
    expect(outline.classList.contains('is-fallback-visible')).toBe(true); expect(OrbLens.create).not.toHaveBeenCalled();
    const points=[...path.getAttribute('d')!.matchAll(/([\d.e+-]+),([\d.e+-]+)/g)].map(m=>[Number(m[1]),Number(m[2])]);
    expect(Math.max(...points.map(p=>p[0]!))-Math.min(...points.map(p=>p[0]!))).toBeCloseTo(12,4);
    expect(Math.max(...points.map(p=>p[1]!))-Math.min(...points.map(p=>p[1]!))).toBeCloseTo(56,4);
    m.widget.open(); await settle();
    expect(outline.classList.contains('is-fallback-visible')).toBe(false); expect(outline.style.display).toBe('none');
    m.widget.close(); await settle(); expect(outline.classList.contains('is-fallback-visible')).toBe(true);
    m.widget.hidden=true; await settle();
    expect(outline.classList.contains('is-fallback-visible')).toBe(false); expect(outline.style.display).toBe('none');
    expect(m.root.querySelector<HTMLCanvasElement>('canvas.fb-orb-lens')!.hidden).toBe(true);
    expect(OrbLens.create).not.toHaveBeenCalled();
  });
  it.each(['left','right'])('%s capsule and hit surface share420ms geometry, safe inset and interruption, without background RAF',side=>{
    vi.stubGlobal('matchMedia',(media:string)=>({matches:false,media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    let id=0; const frames=new Map<number,FrameRequestCallback>(),draw=vi.fn();
    vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frames.set(++id,callback);return id;});
    vi.spyOn(window,'cancelAnimationFrame').mockImplementation(key=>{frames.delete(key);});
    vi.mocked(OrbLens.create).mockReturnValue({draw,dispose:vi.fn(),clearImage:vi.fn(),setImage:vi.fn()} as unknown as OrbLens);
    const m=mount({side}),provider=vi.fn(()=>new Promise<never>(()=>{}));m.widget.captureProvider=provider;
    const probe=m.root.querySelector<HTMLElement>('.fb-safe-insets')!; probe.style.paddingLeft='32px';probe.style.paddingRight='36px';
    m.widget.launcherBottom='31%';
    const step=(time:number)=>{vi.setSystemTime(time);const batch=[...frames.values()];frames.clear();for(const callback of batch) callback(time);};
    const material=()=>draw.mock.calls.at(-1)![5] as {halfSize:{x:number;y:number};handleMix:number;mist:number;idleMix:number};
    expect(frames.size).toBe(0);expect(material().mist).toBe(.74);
    vi.advanceTimersByTime(5000);expect(collapsed(m)).toBe(true); expect(material().halfSize.x).toBe(28);expect(frames.size).toBe(1);
    step(5210); expect(material().halfSize.x).toBeCloseTo(8.75,8);expect(material().handleMix).toBe(.875);
    const before={...draw.mock.calls.at(-1)![0]},half=material().halfSize.x;
    pointer(m,'pointerdown'); pointer(m,'pointerup');
    expect(draw.mock.calls.at(-1)![0]).toEqual(before);expect(material().halfSize.x).toBe(half);expect(provider).not.toHaveBeenCalled();
    step(5300); pointer(m,'pointerdown'); pointer(m,'pointerup'); // another tap during expansion must not cancel idle forever
    expect(provider).not.toHaveBeenCalled(); expect(m.panel.classList.contains('is-open')).toBe(false);
    step(5630);expect(material().halfSize).toEqual({x:28,y:28});expect(frames.size).toBe(0);
    vi.advanceTimersByTime(5000);step(Date.now()+420);
    expect(material().halfSize).toEqual({x:6,y:28});expect(material().handleMix).toBe(1);expect(frames.size).toBe(0);
    const center=draw.mock.calls.at(-1)![0] as {x:number};
    expect(side==='left'?center.x-6:1024-center.x-6).toBe(side==='left'?35:39); // inset+3px
    expect(getComputedStyle(m.orb).width).toBe('44px');expect(getComputedStyle(m.orb).height).toBe('56px');
    expect(parseFloat(m.orb.style.left)).toBe(side==='left'?32:944);
    expect(getComputedStyle(m.root.querySelector('canvas.fb-orb-lens')!).pointerEvents).toBe('none');
    m.orb.click();const stale=[...frames.values()];m.widget.hidden=true;expect(frames.size).toBe(0);
    m.widget.hidden=false;const count=draw.mock.calls.length;for(const callback of stale) callback(Date.now()+1000);
    expect(draw).toHaveBeenCalledTimes(count);expect(material().halfSize).toEqual({x:28,y:28});expect(collapsed(m)).toBe(false);
  });
});

/**
 * 0.8.5：第三种待机样式「隐藏」只隐藏“待机（收起）状态”。
 * - parser 接受 hidden，旧/非法值仍回退 handle（旧组件读到 hidden 也按 handle 安全降级）；
 * - 设置里出现第三张单选卡，脚注说明可用唤醒手势或宿主入口恢复；
 * - 隐藏生效后：完整球初始仍显示，闲置5秒才收起并隐藏（.fb-orb.is-idle-hidden → display:none），
 *   兄弟 canvas/outline 同步收起；已开启的唤醒手势可唤醒完整球，再闲置5秒重新隐藏；
 * - 未开启手势时保持隐藏，但宿主 open() 仍可打开面板并改回 handle / edge；
 * - 偏好按 appId 保存，切走再切回、断开重连都保持。
 */
describe('third idle style: hidden',()=>{
  // 手势起点在宿主页面（不是组件自身 UI）；唤醒手势监听 document。
  beforeEach(()=>{ host=document.createElement('div'); host.textContent='宿主页面'; document.body.append(host); });

  it('parser accepts hidden while invalid and legacy values still fall back to handle',()=>{
    expect(parseOrbIdlePreference('{"version":1,"style":"hidden"}')).toBe('hidden');
    expect(parseOrbIdlePreference('{"version":1,"style":"handle"}')).toBe('handle');
    expect(parseOrbIdlePreference('{"version":1,"style":"edge"}')).toBe('edge');
    for(const value of [null,'bad','{}','{"version":0,"style":"hidden"}','{"version":1,"style":"HIDDEN"}','{"version":1,"style":"hidden "}']) {
      expect(parseOrbIdlePreference(value),`非法值 ${value} 必须回退 handle`).toBe('handle');
    }
  });

  it('settings expose three radio cards and explain the new hidden semantics',()=>{
    const m=mount(); settings(m);
    const values=[...m.root.querySelectorAll<HTMLInputElement>('[data-orb-idle]')].map(input=>input.dataset.orbIdle);
    expect(values).toEqual(['handle','edge','hidden']);
    const titles=[...m.root.querySelectorAll<HTMLElement>('.fb-orb-idle-option')].map(option=>option.textContent);
    expect(titles).toEqual(['小把手','球体贴边','隐藏']);
    const footnote=m.root.querySelector<HTMLElement>('.fb-orb-idle-settings .fb-footnote')!;
    expect(footnote.textContent).toContain('闲置5秒后收起');
    expect(footnote.textContent).toContain('待机不显示灵感球');
    expect(footnote.textContent).toContain('唤醒手势');
    expect(footnote.textContent).toContain('宿主入口');
    expect(footnote.textContent).toContain('改回');
  });

  it('a stored hidden preference shows the full ball first, hides it after 5 seconds, and the wake gesture restores it',async()=>{
    enableGestures();
    localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"hidden"}');
    const m=mount({'capture-mode':'viewport'});
    const outline=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!;
    const canvas=m.root.querySelector<HTMLCanvasElement>('canvas.fb-orb-lens')!;
    expect(m.orb.dataset.idleStyle).toBe('hidden');
    expect(collapsed(m)).toBe(false); expect(idleHidden(m)).toBe(false);
    expect(getComputedStyle(m.orb).display).not.toBe('none');

    vi.advanceTimersByTime(4999); expect(idleHidden(m)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(collapsed(m)).toBe(true); expect(idleHidden(m)).toBe(true);
    expect(getComputedStyle(m.orb).display).toBe('none');
    // 待机隐藏时兄弟采样层必须一起收起，不能留下透明可绘制/可命中的层
    expect(canvas.hidden).toBe(true); expect(outline.style.display).toBe('none');
    expect(outline.classList.contains('is-fallback-visible')).toBe(false);
    expect(m.orb.getAttribute('aria-label')).toBe('唤醒灵感球');

    // 双指长按700ms并松手：隐藏待机不是「入口不可用」，手势必须能唤醒完整球
    const provider=vi.fn(()=>new Promise<never>(()=>{})); m.widget.captureProvider=provider;
    hold(); await settle();
    expect(provider).not.toHaveBeenCalled();
    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(idleHidden(m)).toBe(false); expect(collapsed(m)).toBe(false);
    expect(getComputedStyle(m.orb).display).not.toBe('none');
    expect(outline.style.display).toBe('');
    expect(m.orb.getAttribute('aria-label')).toBe('灵感球：拖动指出问题或点击反馈');
    m.orb.focus(); expect(m.root.activeElement).toBe(m.orb);

    // 唤醒后按正常的5秒闲置重新收起并隐藏
    vi.advanceTimersByTime(4999); expect(idleHidden(m)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(idleHidden(m)).toBe(true);
    expect(getComputedStyle(m.orb).display).toBe('none');
  });

  it('a gesture-woken ball behaves like the normal full ball: held drag pauses idle and click starts capture',async()=>{
    enableGestures();
    localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"hidden"}');
    const m=mount({'capture-mode':'viewport'});
    const provider=vi.fn(()=>new Promise<never>(()=>{})); m.widget.captureProvider=provider;
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(true);

    hold(); await settle();
    expect(idleHidden(m)).toBe(false);
    expect(m.orb.classList.contains('is-dragging')).toBe(false);
    pointer(m,'pointerdown'); pointer(m,'pointermove',200,200);
    expect(m.orb.classList.contains('is-dragging')).toBe(true);
    // 拖拽期间不会误隐藏
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(false);
    pointer(m,'pointercancel',200,200); await settle();
    expect(m.orb.classList.contains('is-dragging')).toBe(false); expect(idleHidden(m)).toBe(false);
    // 取消拖拽后重新计满5秒闲置才隐藏
    vi.advanceTimersByTime(4999); expect(idleHidden(m)).toBe(false);
    vi.advanceTimersByTime(1); expect(idleHidden(m)).toBe(true);

    // 再次唤醒后完整球可点击：单击开始截图（不再被隐藏态挡住）
    hold(); await settle();
    expect(idleHidden(m)).toBe(false);
    pointer(m,'pointerdown'); pointer(m,'pointerup'); await settle();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(idleHidden(m)).toBe(false);
  });

  it('without wake gestures the hidden standby stays hidden, while the host entry can open and switch styles back',async()=>{
    const m=mount({'capture-mode':'viewport'});
    settings(m); radio(m,'hidden').click();
    expect(JSON.parse(localStorage.getItem(orbIdlePreferenceKey(APP_ID))!)).toEqual({version:1,style:'hidden'});
    m.widget.close(); await settle();
    vi.advanceTimersByTime(5000);
    expect(idleHidden(m)).toBe(true);
    // 未启用任何手势：双指长按不应唤醒，待机保持隐藏
    hold(); await settle();
    expect(idleHidden(m)).toBe(true); expect(m.panel.classList.contains('is-open')).toBe(false);

    // 隐藏待机时入口 display:none，但宿主入口 open() 仍可打开面板
    m.widget.open();
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.orb.classList.contains('is-unavailable')).toBe(true); // 面板打开仍是既有的入口不可用条件
    expect(idleHidden(m)).toBe(false); // 面板打开期间不叠加待机隐藏
    m.root.querySelector<HTMLButtonElement>('.fb-settings-btn')!.click();
    expect(radio(m,'hidden').checked).toBe(true);

    // 改回「球体贴边」：关闭面板后先显示完整球，5秒闲置后是贴边待机而不是隐藏
    radio(m,'edge').click();
    expect(JSON.parse(localStorage.getItem(orbIdlePreferenceKey(APP_ID))!)).toEqual({version:1,style:'edge'});
    m.widget.close(); await settle();
    expect(m.orb.classList.contains('is-unavailable')).toBe(false);
    vi.advanceTimersByTime(4999); expect(collapsed(m)).toBe(false); expect(idleHidden(m)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(collapsed(m)).toBe(true); expect(idleHidden(m)).toBe(false);
    expect(m.orb.dataset.idleStyle).toBe('edge');
    expect(getComputedStyle(m.orb).display).not.toBe('none');

    // 再切回「隐藏」：同样在闲置后收起隐藏
    m.widget.open(); m.root.querySelector<HTMLButtonElement>('.fb-settings-btn')!.click(); radio(m,'hidden').click();
    m.widget.close(); await settle();
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(true);
    expect(getComputedStyle(m.orb).display).toBe('none');

    // 改回「小把手」同样恢复简短待机，而不是继续隐藏
    m.widget.open(); m.root.querySelector<HTMLButtonElement>('.fb-settings-btn')!.click(); radio(m,'handle').click();
    m.widget.close(); await settle();
    vi.advanceTimersByTime(5000);
    expect(collapsed(m)).toBe(true); expect(idleHidden(m)).toBe(false);
    expect(m.orb.dataset.idleStyle).toBe('handle');
    expect(getComputedStyle(m.orb).display).not.toBe('none');
    expect(JSON.parse(localStorage.getItem(orbIdlePreferenceKey(APP_ID))!)).toEqual({version:1,style:'handle'});
  });

  it('an open panel never adds the idle-hidden state and does not allow a stray gesture wake',async()=>{
    enableGestures();
    localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"hidden"}');
    const m=mount({'capture-mode':'viewport'});
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(true);
    m.widget.open(); await settle();
    expect(m.panel.classList.contains('is-open')).toBe(true);
    // 面板打开时手势不会唤醒，也不会叠加待机隐藏
    hold(); await settle();
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(idleHidden(m)).toBe(false); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
    vi.advanceTimersByTime(9000); expect(idleHidden(m)).toBe(false);
    // 关闭面板后恢复正常的5秒闲置 → 待机隐藏
    m.widget.close(); await settle();
    expect(m.orb.classList.contains('is-unavailable')).toBe(false);
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(true);
  });

  it('hidden preference survives reconnect and is scoped per appId',async()=>{
    const m=mount(); settings(m); radio(m,'hidden').click();
    expect(JSON.parse(localStorage.getItem(orbIdlePreferenceKey(APP_ID))!)).toEqual({version:1,style:'hidden'});
    m.widget.close(); await settle();
    expect(m.orb.dataset.idleStyle).toBe('hidden');
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(true);

    m.widget.remove(); document.body.append(m.widget); await settle();
    expect(radio(m,'hidden').checked).toBe(true);
    expect(m.orb.dataset.idleStyle).toBe('hidden');
    // 重连后入口可用（不再复用 is-unavailable），先显示完整球，再按闲置重新隐藏
    expect(m.orb.classList.contains('is-unavailable')).toBe(false);
    expect(idleHidden(m)).toBe(false);
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(true);

    // 另一个 appId 没有该偏好 → 回退 handle 并保持可见
    m.widget.appId='other app';
    expect(radio(m,'handle').checked).toBe(true);
    expect(m.orb.dataset.idleStyle).toBe('handle');
    expect(m.orb.classList.contains('is-unavailable')).toBe(false);
    expect(idleHidden(m)).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(collapsed(m)).toBe(true); expect(idleHidden(m)).toBe(false);
    expect(getComputedStyle(m.orb).display).not.toBe('none');

    // 切回原 appId 恢复 hidden 的待机循环
    m.widget.appId=APP_ID;
    expect(radio(m,'hidden').checked).toBe(true);
    expect(m.orb.dataset.idleStyle).toBe('hidden');
    expect(idleHidden(m)).toBe(false);
    vi.advanceTimersByTime(5000); expect(idleHidden(m)).toBe(true);
    expect(getComputedStyle(m.orb).display).toBe('none');
  });

  it('a stored hidden preference starts with the full ball visible and hides only after the idle interval',async()=>{
    localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"hidden"}');
    const m=mount();
    expect(m.orb.dataset.idleStyle).toBe('hidden');
    expect(m.orb.classList.contains('is-unavailable')).toBe(false);
    expect(idleHidden(m)).toBe(false);
    expect(getComputedStyle(m.orb).display).not.toBe('none');
    vi.advanceTimersByTime(5000);
    expect(idleHidden(m)).toBe(true);
    expect(getComputedStyle(m.orb).display).toBe('none');
    // 面板仍可被宿主 API 打开（隐藏只针对待机入口，不锁面板），打开期间不叠加待机隐藏
    m.widget.open();
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(idleHidden(m)).toBe(false);
    expect(m.orb.classList.contains('is-unavailable')).toBe(true);
    // 宿主隐藏等既有不可用条件仍然生效，待机隐藏不会绕过它们
    m.widget.hidden = true; await settle();
    expect(m.orb.classList.contains('is-unavailable')).toBe(true);
    expect(idleHidden(m)).toBe(false);
  });
});

/**
 * 「隐藏」只是第三张卡的语义变化，不改变既有设置卡片布局：
 * 440px 面板内容宽 = 440 − 2×16 = 408px，三卡最小行长 = 3×110 + 2×8 = 346px → 仍为单行；
 * 每张卡保持 44px 最小高度与 flex:1 1 110px，窄屏才换行。
 */
describe('idle standby settings card layout',()=>{
  it('keeps three 110px-basis, 44px-high cards on one row inside the 440px panel',()=>{
    const m=mount(); settings(m);
    const options=m.root.querySelector<HTMLElement>('.fb-orb-idle-options')!;
    const cards=[...options.querySelectorAll<HTMLElement>('.fb-orb-idle-option')];
    expect(cards).toHaveLength(3);
    const optionsStyle=getComputedStyle(options);
    expect(optionsStyle.display).toBe('flex');
    expect(optionsStyle.flexWrap).toBe('wrap');
    expect(optionsStyle.gap).toBe('8px');
    for(const card of cards) {
      const style=getComputedStyle(card);
      expect(style.display).toBe('flex');
      expect(style.minHeight).toBe('44px');
      expect(style.flexGrow).toBe('1');
      expect(style.flexBasis).toBe('110px');
      expect(style.boxSizing).toBe('border-box');
    }
    expect(3*110+2*8).toBeLessThanOrEqual(440-16*2);
    expect(STYLES).toMatch(/\.fb-orb-idle-options \{ display:flex; flex-wrap:wrap; gap:8px; \}/);
    expect(STYLES).toMatch(/\.fb-orb-idle-option \{[^}]*flex:1 1 110px;[^}]*min-height:44px/);
  });
});

