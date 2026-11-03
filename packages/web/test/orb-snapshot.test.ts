import { setTimeout as nextTask } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import * as capture from '../src/capture';
import { OrbLens } from '../src/orb-lens';
import { orbIdlePreferenceKey } from '../src/orb-idle';
import { APP_ID, cleanup, mount, setTextarea } from './helpers';
import { addNode, blobToPng, createFakeRenderer, createState, encodePng, installGeometryPatch, isCoverPixel, pixelColor, stubCreateElementCanvas, type PngImage } from './pixel-fixture';

let restoreGeometry:(()=>void)|null=null;
let uploads:PngImage[];
let closes:ReturnType<typeof vi.fn>[];
let renders:ReturnType<typeof vi.fn>;
let clear:ReturnType<typeof vi.fn>;
let dispose:ReturnType<typeof vi.fn>;
let draws:Parameters<OrbLens['draw']>[];

// Keep the refresh clock explicit while allowing Blob/image tasks to finish.
async function settle() { for(let i=0;i<8;i++) {await nextTask(0);await vi.advanceTimersByTimeAsync(0);} }
async function nextCapture() { await vi.advanceTimersByTimeAsync(250); await settle(); }
function pointer(orb:Element,type:string,x=100,y=100) {
  orb.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,isPrimary:true,pointerId:1,clientX:x,clientY:y}));
}

beforeEach(()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
  uploads=[]; closes=[]; draws=[];
  restoreGeometry=installGeometryPatch();
  const state=createState(); stubCreateElementCanvas(state);
  const renderer=createFakeRenderer(state);
  renders=vi.fn(async (...args:Parameters<typeof renderer>)=>{
    // The renderer deliberately paints leaked pixels; the production final mask must overwrite them.
    const result=await renderer(...args);
    // This fixture uses the live document as its clone; restore it for subsequent captures.
    for(const node of document.querySelectorAll<HTMLElement>('[data-fake-rect]')) node.style.removeProperty('visibility');
    return result;
  });
  const builtin=capture.captureViewport;
  vi.spyOn(capture,'captureViewport').mockImplementation(opts=>builtin({...opts,html2canvas:renders}));
  clear=vi.fn(); dispose=vi.fn();
  vi.spyOn(OrbLens,'create').mockImplementation(canvas=>({
    canvas, clearImage:clear,
    dispose:()=>{ dispose(); canvas.width=canvas.height=1; },
    draw:vi.fn((...args:Parameters<OrbLens['draw']>)=>{ draws.push(args); canvas.width=canvas.height=166; }),
    setImage:vi.fn((image:unknown)=>uploads.push(image as PngImage)),
  }) as unknown as OrbLens);
  vi.stubGlobal('createImageBitmap',async(blob:Blob)=>{
    const png=await blobToPng(blob), close=vi.fn(); closes.push(close);
    return {...png,close};
  });
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:fixture');
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
});
afterEach(()=>{ restoreGeometry?.(); restoreGeometry=null; cleanup(); vi.useRealTimers(); });

describe('decorative lens capture privacy and lifetime',()=>{
  it('only uploads the masked built-in image; provider is called once at actual release',async()=>{
    addNode('<div data-feedback-capture-mask>private account</div>','100,100,120,24');
    const m=mount({'launcher-mode':'orb'}); await settle();
    expect(renders).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
    expect(isCoverPixel(uploads[0]!,150,110)).toBe(true);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    const provider=vi.fn(()=>new Promise<never>(()=>{})); m.widget.captureProvider=provider;
    await nextCapture();
    pointer(m.orb,'pointerdown'); await settle();
    pointer(m.orb,'pointermove',180,140); pointer(m.orb,'pointermove',240,190);
    expect(provider).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(2);
    expect(isCoverPixel(uploads[1]!,150,110)).toBe(true);
    pointer(m.orb,'pointerup',300,220);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]).toBeDefined();
    const ctx=(provider.mock.calls as unknown as Array<[{releasePoint:{x:number;y:number}}]>)[0]![0];
    expect(ctx.releasePoint).toEqual({x:Math.round(300/1024*10000)/10000,y:Math.round(220/768*10000)/10000});
    m.widget.cancelCapture();
    expect(dispose).toHaveBeenCalled();
  });

  it('drag refreshes are bounded; scroll discards old pixels and captures the current scene',async()=>{
    const m=mount({'launcher-mode':'orb'}); await settle();
    expect(renders).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointermove',120,100); await settle();
    expect(renders).toHaveBeenCalledTimes(1);
    pointer(m.orb,'pointercancel');
    await vi.advanceTimersByTimeAsync(200); await settle();
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointermove',120,100); await settle();
    expect(renders).toHaveBeenCalledTimes(2);
    pointer(m.orb,'pointermove',150,100); await settle();
    expect(renders).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('scroll')); await settle();
    expect(clear).toHaveBeenCalled(); expect(renders).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(renders).toHaveBeenCalledTimes(3);
    pointer(m.orb,'pointercancel');
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointermove',140,100); await settle();
    expect(renders).toHaveBeenCalledTimes(3);
  });

  it('late decode is closed after disconnect and never uploaded; no concurrent snapshot while pending',async()=>{
    let resolve!:(image:unknown)=>void;
    vi.stubGlobal('createImageBitmap',()=>new Promise(r=>{ resolve=r; }));
    const m=mount({'launcher-mode':'orb'}); await settle();
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointermove',130,100); await settle();
    expect(renders).toHaveBeenCalledTimes(1);
    m.widget.remove();
    const close=vi.fn(); resolve({width:1024,height:768,close}); await settle();
    expect(close).toHaveBeenCalledTimes(1); expect(uploads).toHaveLength(0);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('snapshot failure leaves the safe outline; forced-colors avoids WebGL entirely',async()=>{
    renders.mockRejectedValue(new Error('capture blocked'));
    const m=mount({'launcher-mode':'orb'}); await settle();
    expect(clear).toHaveBeenCalled(); expect(uploads).toHaveLength(0);
    m.widget.remove();
    vi.mocked(OrbLens.create).mockClear();
    vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(forced-colors: active)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    mount({'launcher-mode':'orb'}); await settle();
    expect(OrbLens.create).not.toHaveBeenCalled();
  });
});

describe('continuously updated safe background',()=>{
  beforeEach(()=>{
    vi.useFakeTimers(); vi.setSystemTime(0);
    vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
    vi.spyOn(window,'innerWidth','get').mockReturnValue(390);
    vi.spyOn(window,'innerHeight','get').mockReturnValue(844);
    vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  });
  async function settled() { for(let i=0;i<8;i++) {await nextTask(0);await vi.advanceTimersByTimeAsync(0);} }

  it.each(['full','edge','handle'] as const)('updates changed host pixels in %s without page-label or pointer changes, preserving opaque masks',async style=>{
    const background=addNode('<div>host background</div>','0,0,390,844',{color:[0,0,255]});
    addNode('<div data-feedback-capture-mask>private account</div>','100,100,120,24');
    if(style==='edge') localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"edge"}');
    const m=mount({'launcher-mode':'orb','show-launcher':'false'});
    const provider=vi.fn(); m.widget.captureProvider=provider; m.widget.showLauncher=true;
    await settled();
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([0,0,255,255]);
    if(style!=='full') {vi.advanceTimersByTime(5000);await settled();}
    const count=renders.mock.calls.length;
    background.setAttribute('data-fake-color','rgb(0,255,0)');
    await vi.advanceTimersByTimeAsync(249); await settled();
    expect(renders).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1); await settled();
    expect(renders).toHaveBeenCalledTimes(count+1);
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([0,255,0,255]);
    background.setAttribute('data-fake-color','rgb(255,255,0)');
    await vi.advanceTimersByTimeAsync(250); await settled();
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([255,255,0,255]);
    expect(m.widget.pageLabel).toBe('settings/account');
    expect(m.orb.classList.contains('is-collapsed')).toBe(style!=='full');
    for(const image of uploads) expect(isCoverPixel(image,150,110)).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });

  it('waits 250ms after a slow capture completes and never overlaps or accumulates captures',async()=>{
    const bitmap=globalThis.createImageBitmap;
    let finish!:()=>void;
    vi.stubGlobal('createImageBitmap',async(blob:Blob)=>{
      const image=await bitmap(blob);
      return new Promise(resolve=>{finish=()=>resolve(image);});
    });
    mount({'launcher-mode':'orb'}); await settled();
    await vi.advanceTimersByTimeAsync(5000); await settled();
    expect(renders).toHaveBeenCalledTimes(1); expect(uploads).toHaveLength(0);
    finish(); await settled();
    expect(uploads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249); await settled();
    expect(renders).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await settled();
    expect(renders).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000); await settled();
    expect(renders).toHaveBeenCalledTimes(2);
    finish(); await settled();
    expect(uploads).toHaveLength(2);
  });

  it('coalesces 20 scroll events at 16ms intervals into bounded captures and samples the final scene',async()=>{
    const background=addNode('<div>host background</div>','0,0,390,844',{color:[0,0,255]});
    addNode('<div data-feedback-capture-mask>private account</div>','100,100,120,24');
    const started:number[]=[],finished:number[]=[];
    const render=renders.getMockImplementation()!;
    renders.mockImplementation(async(...args:Parameters<typeof render>)=>{
      started.push(Date.now());
      try {return await render(...args);}
      finally {finished.push(Date.now());}
    });
    mount({'launcher-mode':'orb'}); await settled();
    for(let i=0;i<20;i++) {
      await vi.advanceTimersByTimeAsync(16);
      background.setAttribute('data-fake-color',i===19?'rgb(0,255,0)':`rgb(${i},0,255)`);
      window.dispatchEvent(new Event('scroll')); await settled();
    }
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(20);
    expect(renders.mock.calls.length).toBeLessThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(250); await settled();
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([0,255,0,255]);
    expect(renders.mock.calls.length).toBeLessThanOrEqual(3);
    for(let i=1;i<started.length;i++) expect(started[i]!-finished[i-1]!).toBeGreaterThanOrEqual(250);
    for(const image of uploads) expect(isCoverPixel(image,150,110)).toBe(true);
  });

  it('clears a failed refresh and stops automatic retries until an explicit restore',async()=>{
    const m=mount({'launcher-mode':'orb'}); await settled();
    expect(uploads).toHaveLength(1);
    renders.mockRejectedValueOnce(new Error('capture blocked'));
    await vi.advanceTimersByTimeAsync(250); await settled();
    expect(clear).toHaveBeenCalled(); expect(renders).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000); await settled();
    expect(renders).toHaveBeenCalledTimes(2);
    m.widget.open(); m.widget.close(); await settled();
    expect(renders).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(250); await settled();
    expect(renders).toHaveBeenCalledTimes(4);
  });

  it.each(['panel','document','host','detach','idle hidden'] as const)('stops background captures while %s and resumes with current host pixels',async gate=>{
    const background=addNode('<div>host background</div>','0,0,390,844',{color:[0,0,255]});
    if(gate==='idle hidden') localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"hidden"}');
    const m=mount({'launcher-mode':'orb'}); await settled();
    if(gate==='panel') m.widget.open();
    if(gate==='document') {vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));}
    if(gate==='host') m.widget.hidden=true;
    if(gate==='detach') m.widget.remove();
    if(gate==='idle hidden') vi.advanceTimersByTime(5000);
    await settled(); const count=renders.mock.calls.length;
    background.setAttribute('data-fake-color','rgb(0,255,0)');
    await vi.advanceTimersByTimeAsync(1000); await settled();
    expect(renders).toHaveBeenCalledTimes(count);
    if(gate==='panel') m.widget.close();
    if(gate==='document') {vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));}
    if(gate==='host') m.widget.hidden=false;
    if(gate==='detach') document.body.append(m.widget);
    if(gate==='idle hidden') {
      // A configured wake gesture calls the same internal path; DOM events here
      // cannot hit a display:none launcher, so restore via the supported host panel.
      m.widget.open(); m.widget.close();
    }
    await settled();
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([0,255,0,255]);
    await vi.advanceTimersByTimeAsync(250); await settled();
    expect(renders.mock.calls.length).toBeGreaterThan(count);
  });
});


describe('R7 safe-texture ownership',()=>{
  beforeEach(()=>{
    vi.useFakeTimers(); vi.setSystemTime(0);
    vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
    vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  });
  // Blob/image operations and happy-dom observers use the real task queue, not idle time.
  async function settled() { for(let i=0;i<8;i++) {await nextTask(0);await vi.advanceTimersByTimeAsync(0);} }
  function launcher(attributes:Record<string,string>={}) {
    const m=mount({'launcher-mode':'orb','show-launcher':'false','capture-mode':'viewport',...attributes});
    const provider=vi.fn(()=>new Promise<never>(()=>{})); m.widget.captureProvider=provider;
    m.widget.showLauncher=true;
    return {...m,provider};
  }
  function expectHandle(dark=false) {
    // R11 changes only the dark handle; ownership and masked sampling stay fixed.
    expect(draws.at(-1)![5]).toEqual({halfSize:dark?{x:5,y:24}:{x:6,y:28},handleMix:1,mist:.74,idleMix:1});
  }
  it.each(['full','handle','edge'].flatMap(style=>['explicit','system'].map(trigger=>({style,trigger}))))('R7 theme $trigger refreshes one masked background for the visible $style and wake keeps the new pixels',async({style,trigger})=>{
    vi.spyOn(window,'innerWidth','get').mockReturnValue(390);
    vi.spyOn(window,'innerHeight','get').mockReturnValue(844);
    const {change}=colorScheme(false,true);
    const background=addNode('<div>host background</div>','0,0,390,844',{color:[245,246,250]});
    addNode('<div data-feedback-capture-mask>private account</div>','100,100,120,24');
    if(style==='edge') localStorage.setItem(orbIdlePreferenceKey(APP_ID),'{"version":1,"style":"edge"}');
    const m=launcher({theme:trigger==='system'?'system':'light'}); await settled();
    expect(renders).toHaveBeenCalledTimes(1); expect(pixelColor(uploads[0]!,20,20)).toEqual([245,246,250,255]);
    if(style!=='full') {vi.advanceTimersByTime(5000);await settled();}
    expect(m.orb.classList.contains('is-collapsed')).toBe(style!=='full');
    const beforeTheme=renders.mock.calls.length;
    clear.mockClear(); background.setAttribute('data-fake-color','rgb(20,22,28)');
    if(trigger==='system') change(true); else m.widget.theme='dark';
    await nextCapture();
    expect(renders).toHaveBeenCalledTimes(beforeTheme+1); expect(uploads).toHaveLength(beforeTheme+1);
    expect(clear).toHaveBeenCalledTimes(1); expect(draws.at(-1)![4]).toBe(true);
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([20,22,28,255]);
    for(const image of uploads) expect(isCoverPixel(image,150,110)).toBe(true);
    for(const close of closes) expect(close).toHaveBeenCalledTimes(1);
    expect(m.orb.classList.contains('is-collapsed')).toBe(style!=='full');
    if(style!=='full') {
      pointer(m.orb,'pointerdown'); pointer(m.orb,'pointerup'); m.orb.click(); await settled();
      expect(m.panel.classList.contains('is-open')).toBe(false);
      vi.advanceTimersByTime(5000); await settled();
    }
    expect(renders).toHaveBeenCalledTimes(beforeTheme+(style==='full'?1:2));
    expect(uploads).toHaveLength(renders.mock.calls.length);
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([20,22,28,255]);
    expect(dispose).not.toHaveBeenCalled(); expect(m.provider).not.toHaveBeenCalled();
  });
  it('R7 theme changes discard the old decoded pixels, close them once and queue only the latest masked capture',async()=>{
    const bitmap=globalThis.createImageBitmap; let finish!:()=>void,first=true;
    vi.stubGlobal('createImageBitmap',async(blob:Blob)=>{
      const image=await bitmap(blob);
      if(first) {first=false;return new Promise(resolve=>{finish=()=>resolve(image);});}
      return image;
    });
    const background=addNode('<div>host background</div>','0,0,1024,768',{color:[245,246,250]});
    addNode('<div data-feedback-capture-mask>private account</div>','100,100,120,24');
    const m=launcher({theme:'light'}); await settled(); vi.advanceTimersByTime(5000); expectHandle();
    background.setAttribute('data-fake-color','rgb(20,22,28)');
    m.widget.theme='dark'; m.widget.theme='light'; m.widget.theme='dark'; await settled();
    expect(renders).toHaveBeenCalledTimes(1); expect(uploads).toHaveLength(0);
    expect(closes[0]).not.toHaveBeenCalled();
    finish(); await settled();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
    await nextCapture();
    expect(renders).toHaveBeenCalledTimes(2); expect(uploads).toHaveLength(1);
    expect(pixelColor(uploads[0]!,20,20)).toEqual([20,22,28,255]);
    expect(isCoverPixel(uploads[0]!,150,110)).toBe(true); expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(capture.captureViewport).toHaveBeenCalledTimes(2);
    expect(vi.mocked(capture.captureViewport).mock.calls[0]![0].signal?.aborted).toBe(true);
    expectHandle(true); expect(m.provider).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  });
  it.each(['panel','host','background'] as const)('R7 theme changes during %s do not capture; restoration samples the latest host once and keeps the draft',async gate=>{
    const {change}=colorScheme(false,true),m=launcher({theme:'system'}); await settled();
    setTextarea(m,'keep the existing draft');
    if(gate==='panel') m.widget.open();
    if(gate==='host') m.widget.hidden=true;
    if(gate==='background') {vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));}
    await settled(); const count=renders.mock.calls.length,uploaded=uploads.length;
    change(true); m.widget.theme='dark'; await settled();
    expect(renders).toHaveBeenCalledTimes(count); expect(uploads).toHaveLength(uploaded);
    expect(m.textarea.value).toBe('keep the existing draft'); expect(m.provider).not.toHaveBeenCalled();
    if(gate==='panel') m.widget.close();
    if(gate==='host') m.widget.hidden=false;
    if(gate==='background') {vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));}
    await nextCapture();
    expect(renders).toHaveBeenCalledTimes(count+1); expect(uploads).toHaveLength(uploaded+1);
    expect(draws.at(-1)![4]).toBe(true); expect(m.textarea.value).toBe('keep the existing draft');
    expect(m.provider).not.toHaveBeenCalled();
  });
  it('collapse and wake retain sampler ownership while continuing masked refreshes without calling the formal provider',async()=>{
    const background=addNode('<div>host background</div>','0,0,1024,768',{color:[0,0,255]});
    addNode('<div data-feedback-capture-mask>private account</div>','100,100,120,24');
    const m=launcher(); await settled();
    expect(renders).toHaveBeenCalledTimes(1); expect(uploads).toHaveLength(1);
    expect(isCoverPixel(uploads[0]!,150,110)).toBe(true); expect(closes[0]).toHaveBeenCalledTimes(1);
    background.setAttribute('data-fake-color','rgb(0,255,0)');
    vi.advanceTimersByTime(5000); await settled(); expectHandle();
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([0,255,0,255]);
    const canvas=m.root.querySelector<HTMLCanvasElement>('canvas.fb-orb-lens')!;
    expect(canvas.hidden).toBe(false); expect(canvas.width).toBeGreaterThan(1);
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointerup'); m.orb.click(); await settled();
    expect(draws.at(-1)![5]).toEqual({halfSize:{x:28,y:28},handleMix:0,mist:.74,idleMix:1});
    expect(m.panel.classList.contains('is-open')).toBe(false);
    background.setAttribute('data-fake-color','rgb(255,255,0)');
    vi.advanceTimersByTime(5000); await settled(); expectHandle();
    expect(renders).toHaveBeenCalledTimes(3); expect(uploads).toHaveLength(3);
    expect(pixelColor(uploads.at(-1)!,20,20)).toEqual([255,255,0,255]);
    for(const image of uploads) expect(isCoverPixel(image,150,110)).toBe(true);
    expect(dispose).not.toHaveBeenCalled(); expect(m.provider).not.toHaveBeenCalled();
  });
  it('an in-flight safe decode crosses full→handle once, uploads to the visible capsule and closes exactly once',async()=>{
    let resolve!:(image:unknown)=>void;
    vi.stubGlobal('createImageBitmap',()=>new Promise(r=>{resolve=r;}));
    const m=launcher(); await settled();
    vi.advanceTimersByTime(5000); await settled(); expectHandle();
    expect(renders).toHaveBeenCalledTimes(1); expect(uploads).toHaveLength(0);
    const close=vi.fn(); resolve({width:1024,height:768,close}); await settled();
    expectHandle(); expect(close).toHaveBeenCalledTimes(1); expect(uploads).toHaveLength(1);
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointerup'); await settled();
    expect(renders).toHaveBeenCalledTimes(1); expect(dispose).not.toHaveBeenCalled(); expect(m.provider).not.toHaveBeenCalled();
  });
  it.each(['panel','document','host','app','server','resize','detach'] as const)('%s invalidates a handle decode; only the newest visible generation uploads after restoration',async action=>{
    const bitmap=globalThis.createImageBitmap; let resolve!:(image:unknown)=>void,first=true;
    vi.stubGlobal('createImageBitmap',(blob:Blob)=>{
      if(first) {first=false;return new Promise(r=>{resolve=r;});}
      return bitmap(blob);
    });
    const m=launcher(); await settled(); vi.advanceTimersByTime(5000); await settled(); expectHandle();
    const canvas=m.root.querySelector<HTMLCanvasElement>('canvas.fb-orb-lens')!;
    if(action==='panel') m.widget.open();
    if(action==='document') {vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');document.dispatchEvent(new Event('visibilitychange'));}
    if(action==='host') m.widget.hidden=true;
    if(action==='app') m.widget.appId='next-app';
    if(action==='server') m.widget.apiBase='http://next-api.test';
    if(action==='resize') {vi.spyOn(window,'innerWidth','get').mockReturnValue(1000);window.dispatchEvent(new Event('resize'));}
    if(action==='detach') m.widget.remove();
    await settled(); expect(dispose).toHaveBeenCalled();
    if(['panel','document','host','detach'].includes(action)) expect(canvas.hidden).toBe(true);
    if(action==='panel') m.widget.close();
    if(action==='document') {vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');document.dispatchEvent(new Event('visibilitychange'));}
    if(action==='host') m.widget.hidden=false;
    if(action==='detach') document.body.append(m.widget);
    await settled(); expect(renders).toHaveBeenCalledTimes(1); // old decode is still the sole in-flight request
    const close=vi.fn(); resolve({width:1024,height:768,close}); await settled();
    expect(close).toHaveBeenCalledTimes(1); expect(renders).toHaveBeenCalledTimes(1);
    await nextCapture();
    expect(renders).toHaveBeenCalledTimes(2);
    expect(uploads).toHaveLength(1); expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(canvas.hidden).toBe(false); expect(m.provider).not.toHaveBeenCalled();
    expect(draws.at(-1)![5]).toEqual({halfSize:{x:28,y:28},handleMix:0,mist:.74,idleMix:1});
  });
});

describe('visible orb lens restoration',()=>{
  it('open → close recreates a visible sampled lens without pointerenter or another drag',async()=>{
    const m=mount({'launcher-mode':'orb'}); await settle();
    const canvas=m.root.querySelector<HTMLCanvasElement>('.fb-orb-lens')!;
    expect(uploads).toHaveLength(1);
    m.widget.open();
    expect(canvas.hidden).toBe(true); expect(canvas.width).toBe(1);
    m.widget.close(); await nextCapture();
    expect(canvas.hidden).toBe(false); expect(canvas.width).toBeGreaterThan(1);
    expect(m.orb.classList.contains('has-lens')).toBe(true);
    expect(uploads).toHaveLength(2);
    const count=renders.mock.calls.length;
    await settle(); expect(renders).toHaveBeenCalledTimes(count);
  });

  it.each(['Escape','cancel'] as const)('selection → %s restores sampling and retains provider release-only semantics',async action=>{
    const m=mount({'launcher-mode':'orb'}); await settle();
    const blob=new Blob([encodePng(40,40,new Uint8ClampedArray(40*40*4))],{type:'image/png'});
    const provider=vi.fn(async()=>({blob,width:40,height:40})); m.widget.captureProvider=provider;
    await settle();
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointermove',180,140); pointer(m.orb,'pointerup',180,140);
    await settle();
    expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(false);
    const before=uploads.length;
    if(action==='Escape') document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    else m.root.querySelector<HTMLButtonElement>('.fb-region-cancel')!.click();
    await nextCapture();
    const canvas=m.root.querySelector<HTMLCanvasElement>('.fb-orb-lens')!;
    expect(canvas.hidden).toBe(false); expect(canvas.width).toBeGreaterThan(1);
    expect(uploads).toHaveLength(before+1);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(m.root.activeElement).toBe(m.orb);
  });

  it('closing/reopening while an old decode is pending replays only the newest visible snapshot request',async()=>{
    const bitmap=globalThis.createImageBitmap;
    let resolve!:(image:unknown)=>void;
    let first=true;
    vi.stubGlobal('createImageBitmap',(blob:Blob)=>{
      if(first) { first=false; return new Promise(r=>{resolve=r;}); }
      return bitmap(blob);
    });
    const m=mount({'launcher-mode':'orb'}); await settle();
    const provider=vi.fn(()=>new Promise<never>(()=>{})); m.widget.captureProvider=provider;
    m.widget.open(); m.widget.close(); await settle();
    m.widget.open(); m.widget.close(); await settle();
    expect(renders).toHaveBeenCalledTimes(1); expect(uploads).toHaveLength(0);
    const close=vi.fn(); resolve({width:1024,height:768,close}); await settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(renders).toHaveBeenCalledTimes(1);
    await nextCapture();
    expect(renders).toHaveBeenCalledTimes(2); expect(uploads).toHaveLength(1);
    expect(m.root.querySelector<HTMLCanvasElement>('.fb-orb-lens')!.hidden).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    await settle(); expect(renders).toHaveBeenCalledTimes(2);
  });

  it('closing a pending formal capture restores the lens; its late provider result cannot hide it or reopen the panel',async()=>{
    const m=mount({'launcher-mode':'orb'}); await settle();
    let resolve!:(result:{blob:Blob;width:number;height:number})=>void;
    const provider=vi.fn(()=>new Promise<{blob:Blob;width:number;height:number}>(r=>{resolve=r;}));
    m.widget.captureProvider=provider; await settle();
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointermove',180,140); pointer(m.orb,'pointerup',180,140);
    expect(provider).toHaveBeenCalledTimes(1);
    m.widget.close(); await settle();
    const canvas=m.root.querySelector<HTMLCanvasElement>('.fb-orb-lens')!;
    expect(canvas.hidden).toBe(false); expect(m.orb.classList.contains('has-lens')).toBe(true);
    m.widget.open(); m.widget.close(); await settle();
    const count=renders.mock.calls.length;
    const blob=new Blob([encodePng(40,40,new Uint8ClampedArray(40*40*4))],{type:'image/png'});
    resolve({blob,width:40,height:40}); await settle();
    expect(canvas.hidden).toBe(false); expect(canvas.width).toBeGreaterThan(1);
    expect(m.panel.classList.contains('is-open')).toBe(false);
    expect(m.screenshotWrap.hidden).toBe(true);
    expect(renders).toHaveBeenCalledTimes(count);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('an aborted old renderer finishes before the queued replacement starts, without overlapping captures',async()=>{
    const renderer=renders.getMockImplementation()!;
    let finish!:(canvas:HTMLCanvasElement)=>void;
    let oldArgs!:Parameters<typeof renderer>;
    renders.mockImplementationOnce((...args)=>{oldArgs=args; return new Promise<HTMLCanvasElement>(r=>{finish=r;});});
    const m=mount({'launcher-mode':'orb'}); await settle();
    m.widget.open(); m.widget.close(); await settle();
    expect(renders).toHaveBeenCalledTimes(1);
    finish(await renderer(...oldArgs)); await settle();
    expect(renders).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249); await settle();
    expect(renders).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await settle();
    expect(renders).toHaveBeenCalledTimes(2);
    expect(uploads).toHaveLength(1);
    expect(m.root.querySelector<HTMLCanvasElement>('.fb-orb-lens')!.hidden).toBe(false);
    await settle(); expect(renders).toHaveBeenCalledTimes(2);
  });

  it.each(['tab','hidden launcher','forced colors','hidden document'] as const)('returning from panel respects %s gating',async gate=>{
    const m=mount({'launcher-mode':'orb'}); await settle(); m.widget.open();
    if(gate==='tab') m.widget.launcherMode='tab';
    else if(gate==='hidden launcher') m.widget.showLauncher=false;
    else if(gate==='forced colors') vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(forced-colors: active)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    else vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
    const count=vi.mocked(OrbLens.create).mock.calls.length;
    m.widget.close(); await settle();
    expect(OrbLens.create).toHaveBeenCalledTimes(count);
    expect(m.root.querySelector<HTMLCanvasElement>('.fb-orb-lens')!.hidden).toBe(true);
  });
});

function colorScheme(initial=false,reducedMotion=false) {
  const scheme=Object.assign(new EventTarget(),{matches:initial,media:'(prefers-color-scheme: dark)'});
  vi.stubGlobal('matchMedia',(media:string)=>media===scheme.media?scheme:{matches:reducedMotion && media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()});
  return {scheme,change(dark:boolean){scheme.matches=dark; scheme.dispatchEvent(new Event('change'));}};
}

describe('R3 neutral glass and component theme',()=>{
  it('explicit light/dark refreshes safe pixels without changing the host; explicit theme ignores system changes',async()=>{
    const {change}=colorScheme(true);
    document.documentElement.setAttribute('data-host-theme','unchanged');
    const m=mount({'launcher-mode':'orb','theme':'light'}); await settle();
    expect(draws.at(-1)![4]).toBe(false);
    const captures=renders.mock.calls.length;
    m.widget.theme='dark'; expect(draws.at(-1)![4]).toBe(true);
    await nextCapture(); expect(renders).toHaveBeenCalledTimes(captures+1);
    m.widget.theme='light'; expect(draws.at(-1)![4]).toBe(false);
    await nextCapture(); expect(renders).toHaveBeenCalledTimes(captures+2);
    const count=draws.length; change(false); change(true);
    await settle(); expect(draws).toHaveLength(count); expect(renders).toHaveBeenCalledTimes(captures+2);
    expect(document.documentElement.getAttribute('data-host-theme')).toBe('unchanged');
    document.documentElement.removeAttribute('data-host-theme');
  });
  it('system changes refresh the safe texture and detach removes its media listener',async()=>{
    const {change}=colorScheme(false);
    const m=mount({'launcher-mode':'orb'}); await settle();
    expect(draws.at(-1)![4]).toBe(false);
    const captures=renders.mock.calls.length;
    change(true); expect(draws.at(-1)![4]).toBe(true);
    await nextCapture(); expect(renders).toHaveBeenCalledTimes(captures+1);
    m.widget.theme='light'; expect(draws.at(-1)![4]).toBe(false);
    await nextCapture(); expect(renders).toHaveBeenCalledTimes(captures+2);
    change(false); change(true); await settle(); expect(draws.at(-1)![4]).toBe(false);
    expect(renders).toHaveBeenCalledTimes(captures+2);
    m.widget.theme='system'; expect(draws.at(-1)![4]).toBe(true);
    await nextCapture(); expect(renders).toHaveBeenCalledTimes(captures+3);
    m.widget.remove(); const count=draws.length; change(false); await settle();
    expect(draws).toHaveLength(count); expect(renders).toHaveBeenCalledTimes(captures+3);
  });
  it('the selection recolors without recapture, entrance restart or changing its frozen image and existing attachment/draft',async()=>{
    let now=0; vi.spyOn(performance,'now').mockImplementation(()=>now);
    const {change}=colorScheme(true);
    const m=mount({'launcher-mode':'orb'}); await settle();
    const blob=new Blob([encodePng(40,40,new Uint8ClampedArray(40*40*4))],{type:'image/png'});
    const provider=vi.fn(async()=>({blob,width:40,height:40})); m.widget.captureProvider=provider;
    m.widget.open(); setTextarea(m,'keep the old description');
    const file=new File([encodePng(4,4,new Uint8ClampedArray(4*4*4).fill(255))],'old-attachment.png',{type:'image/png'});
    const input=m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
    Object.defineProperty(input,'files',{value:[file],configurable:true}); input.dispatchEvent(new Event('change'));
    await settle(); m.widget.close(); await settle();
    expect(m.root.querySelector('.fb-screenshot-size')!.textContent).toBe('4×4');
    const attachment=m.screenshotThumb.src;
    pointer(m.orb,'pointerdown'); pointer(m.orb,'pointermove',180,140); pointer(m.orb,'pointerup',180,140); await settle();
    expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(false);
    expect(draws.at(-1)![4]).toBe(true);
    expect(draws.at(-1)![5]).toBeUndefined(); // selection keeps the R3 clear material defaults
    const frozen=m.root.querySelector<HTMLImageElement>('.fb-region-bg')!.src;
    const captures=renders.mock.calls.length,clears=clear.mock.calls.length,urls=vi.mocked(URL.createObjectURL).mock.calls.length;
    now=80; change(false);
    expect(draws.at(-1)![4]).toBe(false);
    expect(draws.at(-1)![3]).toBeGreaterThan(0); expect(draws.at(-1)![3]).toBeLessThan(1);
    const width=parseFloat(m.root.querySelector<HTMLElement>('.fb-region-frame')!.style.width);
    expect(width).toBeGreaterThan(56); // seed scales from the provider's 40px viewport to 1024px
    expect(provider).toHaveBeenCalledTimes(1);
    m.widget.theme='dark'; expect(draws.at(-1)![4]).toBe(true);
    await settle();
    expect(renders).toHaveBeenCalledTimes(captures); expect(clear).toHaveBeenCalledTimes(clears);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(urls);
    expect(m.root.querySelector<HTMLImageElement>('.fb-region-bg')!.src).toBe(frozen);
    expect(m.screenshotThumb.src).toBe(attachment); expect(m.textarea.value).toBe('keep the old description');
    expect(m.root.querySelector('.fb-screenshot-size')!.textContent).toBe('4×4');
    m.root.querySelector<HTMLButtonElement>('.fb-region-cancel')!.click(); await settle();
    expect(m.screenshotThumb.src).toBe(attachment); expect(m.textarea.value).toBe('keep the old description');
    expect(m.root.querySelector('.fb-screenshot-size')!.textContent).toBe('4×4'); expect(provider).toHaveBeenCalledTimes(1);
  });
  it('stationary material hides the old blue/orange halo, sweep and breathing while preserving the focus node and removing the unread badge',async()=>{
    const m=mount({'launcher-mode':'orb'}); await settle();
    expect(m.orb.classList.contains('has-lens')).toBe(true);
    expect(window.getComputedStyle(m.orb).animation).toBe('none');
    for(const selector of ['.fb-orb-bloom','.fb-orb-glow','.fb-orb-sweep']) {
      expect(window.getComputedStyle(m.orb.querySelector(selector)!).display).toBe('none');
    }
    expect(m.orb.querySelector('.fb-orb-focus-ring')).not.toBeNull();
    // 0.8.2：入口未读数字角标整体移除，不再有该节点。
    expect(m.orb.querySelector('.fb-launcher-badge')).toBeNull();
  });
  it('without WebGL the stationary safe outline also suppresses old halos and never starts a backdrop capture',async()=>{
    vi.mocked(OrbLens.create).mockReturnValue(null);
    const m=mount({'launcher-mode':'orb'}); await settle();
    const outline=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!;
    expect(outline.style.display).toBe(''); expect(outline.querySelector('path')!.getAttribute('fill')).toBe('none');
    expect(outline.querySelector('path')!.getAttribute('d')).toMatch(/^M/);
    expect(m.orb.classList.contains('has-lens')).toBe(true);
    expect(window.getComputedStyle(m.orb.querySelector('.fb-orb-glow')!).display).toBe('none');
    expect(renders).not.toHaveBeenCalled(); expect(uploads).toHaveLength(0);
  });
});
