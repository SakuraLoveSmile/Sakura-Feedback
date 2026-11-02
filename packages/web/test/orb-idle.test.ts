import { setTimeout as nextTask } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { OrbLens } from '../src/orb-lens';
import { orbIdlePreferenceKey, parseOrbIdlePreference } from '../src/orb-idle';
import { APP_ID, cleanup, mount as mountBase, type Mounted } from './helpers';
import { wakePreferenceKey } from '../src/wake-gestures';
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
