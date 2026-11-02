import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { OrbLens } from '../src/orb-lens';
import { WAKE_GESTURES, wakePreferenceKey, type WakeGestureId } from '../src/wake-gestures';
import { APP_ID, cleanup, mount as mountBase, setTextarea, type Mounted } from './helpers';
import { blobToPng, createState, encodePng, stubCreateElementCanvas } from './pixel-fixture';
// R5 changes successful gesture behavior from capture to launcher wake; the same
// recognizer/lifecycle exclusions remain covered, followed by explicit drag capture.
const mount = (attributes:Record<string,string>={}) => mountBase({'launcher-mode':'orb',...attributes});
let host: HTMLDivElement;
function drag(m:Mounted) {
  for(const [type,x,y] of [['pointerdown',100,100],['pointermove',200,200],['pointerup',200,200]] as const) {
    m.orb.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,isPrimary:true,pointerId:1,clientX:x,clientY:y}));
  }
}
const enabled = (app=APP_ID, ids:readonly WakeGestureId[]=WAKE_GESTURES.map(g=>g.id)) => localStorage.setItem(wakePreferenceKey(app),JSON.stringify({version:1,enabled:ids}));
const points = (y=200) => [new Touch({identifier:1,target:host,clientX:120,clientY:y}),new Touch({identifier:2,target:host,clientX:160,clientY:y})];
function touch(type:string,active:Touch[],changed=active,target:EventTarget=host) {
  const event=new TouchEvent(type,{bubbles:true,cancelable:true,composed:true,touches:active,changedTouches:changed}); target.dispatchEvent(event); return event;
}
function holdStart() { touch('touchstart',points()); }
function release() { touch('touchend',[],points()); }
function hold() {holdStart(); vi.advanceTimersByTime(700); release();}
async function settle() { for(let i=0;i<6;i++) await vi.advanceTimersByTimeAsync(1); }
function provider(m:Mounted) {
  const capture=vi.fn(async()=>({blob:new Blob([encodePng(40,30,new Uint8ClampedArray(40*30*4))],{type:'image/png'}),width:40,height:30,viewport:{width:1024,height:768}}));
  m.widget.captureProvider=capture; return capture;
}
function checkbox(m:Mounted,id:WakeGestureId='two-finger-hold') {return m.root.querySelector<HTMLInputElement>(`[data-wake-gesture="${id}"]`)!;}
function settings(m:Mounted) {m.widget.open(); m.root.querySelector<HTMLButtonElement>('.fb-settings-btn')!.click();}

beforeEach(()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
  vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  vi.spyOn(OrbLens,'create').mockReturnValue(null);
  stubCreateElementCanvas(createState());
  vi.stubGlobal('createImageBitmap',async(blob:Blob)=>({...await blobToPng(blob),close:vi.fn()}));
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:wake-fixture'); vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  host=document.createElement('div'); host.textContent='宿主页面'; document.body.append(host);
});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe('root wake preference and settings behavior',()=>{
  it('default off; root-restored gesture waits for all fingers up, only wakes at the original dock and starts a fresh idle interval',async()=>{
    const initial=mount({'capture-mode':'viewport'}), off=provider(initial);
    vi.advanceTimersByTime(5000); hold(); await settle();
    expect(off).not.toHaveBeenCalled(); expect(initial.orb.classList.contains('is-collapsed')).toBe(true); initial.widget.remove();
    enabled(); const m=mount({'capture-mode':'viewport','launcher-bottom':'31%'}),capture=provider(m);
    vi.advanceTimersByTime(5000); expect(m.orb.classList.contains('is-collapsed')).toBe(true);
    vi.advanceTimersByTime(5000); holdStart(); vi.advanceTimersByTime(700);
    expect(m.root.querySelector<HTMLElement>('.fb-wake-hint')!.hidden).toBe(false);
    expect(m.orb.classList.contains('is-collapsed')).toBe(true);
    release(); await settle();
    expect(capture).not.toHaveBeenCalled(); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
    expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(true);
    expect(m.panel.classList.contains('is-open')).toBe(false); expect(m.screenshotWrap.hidden).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-wake-hint')!.hidden).toBe(true);
    expect(m.widget.launcherBottom).toBe('31%'); expect(m.orb.style.transform).toBe('');
    vi.advanceTimersByTime(4900); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
    vi.advanceTimersByTime(100); expect(m.orb.classList.contains('is-collapsed')).toBe(true);
  });
  it.each(['three-finger-swipe-up','two-finger-double-tap'] as const)('%s wakes without capture; a subsequent intentional drag retains selection and confirmation',async id=>{
    enabled(APP_ID,[id]); const m=mount({'capture-mode':'viewport'}),capture=provider(m);
    vi.advanceTimersByTime(5000);
    if(id==='three-finger-swipe-up') {
      const c=new Touch({identifier:3,target:host,clientX:200,clientY:200});
      touch('touchstart',[...points(),c]);
      const moved=[...points(120),new Touch({identifier:3,target:host,clientX:200,clientY:120})];
      touch('touchmove',moved); expect(capture).not.toHaveBeenCalled(); touch('touchend',[],moved);
    } else {
      for(let i=0;i<2;i++) {touch('touchstart',points()); vi.advanceTimersByTime(40); release();}
    }
    await settle(); expect(capture).not.toHaveBeenCalled(); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
    expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(true); expect(m.screenshotWrap.hidden).toBe(true);
    drag(m); await settle(); expect(capture).toHaveBeenCalledTimes(1);
    expect(m.root.querySelector<HTMLElement>('.fb-region-frame')!.dataset.size).toBe('144×144');
    m.root.querySelector<HTMLButtonElement>('.fb-region-use')!.click(); await settle();
    expect(m.panel.classList.contains('is-open')).toBe(true); expect(m.screenshotWrap.hidden).toBe(false);
  });
  it('a real touch sequence replaces keyboard modality without blurring the returned orb focus, then idles again',()=>{
    enabled(); const m=mount({'capture-mode':'viewport'}),capture=provider(m);
    m.widget.open();
    m.textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true}));
    expect(m.root.activeElement).toBe(m.orb);
    vi.advanceTimersByTime(9000); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
    hold(); expect(capture).not.toHaveBeenCalled(); expect(m.root.activeElement).toBe(m.orb);
    expect(m.orb.classList.contains('is-collapsed')).toBe(false);
    vi.advanceTimersByTime(4999); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
    vi.advanceTimersByTime(1); expect(m.orb.classList.contains('is-collapsed')).toBe(true);
  });
  it('settings are independent from server saving, persist per app, survive remount and server address changes',async()=>{
    const m=mount({'capture-mode':'viewport'}); settings(m);
    expect(m.root.querySelector('.fb-settings-btn')!.getAttribute('aria-label')).toBe('设置');
    checkbox(m).click(); checkbox(m,'three-finger-swipe-up').click();
    expect(JSON.parse(localStorage.getItem(wakePreferenceKey(APP_ID))!)).toEqual({version:1,enabled:['two-finger-hold','three-finger-swipe-up']});
    m.widget.close(); m.widget.apiBase='http://new-api.test';
    expect(checkbox(m).checked).toBe(true); expect(checkbox(m,'three-finger-swipe-up').checked).toBe(true);
    m.widget.appId='other'; expect(checkbox(m).checked).toBe(false);
    m.widget.appId=APP_ID; expect(checkbox(m).checked).toBe(true);
    m.widget.remove(); const next=mount({'capture-mode':'viewport'}); expect(checkbox(next).checked).toBe(true);
    const capture=provider(next); vi.advanceTimersByTime(5000); hold(); await settle(); expect(capture).not.toHaveBeenCalled(); expect(next.orb.classList.contains('is-collapsed')).toBe(false);
  });
  it('off mode disables options and displays authorization reason; restored choices cannot bypass it',async()=>{
    enabled(); const m=mount(); const capture=provider(m); settings(m);
    expect(checkbox(m).disabled).toBe(true); expect(m.root.querySelector('.fb-wake-availability')!.textContent).toBe('应用未开启截图，手势暂不可用');
    checkbox(m).click(); expect(checkbox(m).checked).toBe(true);
    m.widget.close(); m.orb.blur(); vi.advanceTimersByTime(5000); hold(); await settle(); expect(capture).not.toHaveBeenCalled(); expect(m.orb.classList.contains('is-collapsed')).toBe(true);
    m.widget.captureMode='viewport'; expect(checkbox(m).disabled).toBe(false); hold(); await settle(); expect(capture).not.toHaveBeenCalled(); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
  });
  it('storage write failure remains effective this session and reconnect cannot overwrite the choice',async()=>{
    const m=mount({'capture-mode':'viewport'}); settings(m);
    vi.spyOn(window.localStorage,'setItem').mockImplementation(()=>{throw new Error('blocked');});
    checkbox(m).click(); expect(m.root.querySelector<HTMLElement>('.fb-wake-pref-hint')!.hidden).toBe(false);
    expect(m.root.querySelector('.fb-wake-pref-hint')!.textContent).toBe('仅本次生效');
    m.widget.close(); m.widget.remove(); document.body.append(m.widget); await settle();
    expect(checkbox(m).checked).toBe(true); const capture=provider(m); vi.advanceTimersByTime(5000); hold(); await settle(); expect(capture).not.toHaveBeenCalled(); expect(m.orb.classList.contains('is-collapsed')).toBe(false);
  });
  it('storage read failure defaults off with session hint; later immediate edits do not get a deferred overwrite',async()=>{
    vi.spyOn(window.localStorage,'getItem').mockImplementation(()=>{throw new Error('blocked');});
    const m=mount({'capture-mode':'viewport'}); settings(m);
    expect(checkbox(m).checked).toBe(false); expect(m.root.querySelector<HTMLElement>('.fb-wake-pref-hint')!.hidden).toBe(false);
    checkbox(m).click(); await settle(); expect(checkbox(m).checked).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-wake-pref-hint')!.hidden).toBe(true);
  });
});

describe('wake lifecycle, exclusions and real draft boundary',()=>{
  it.each(['close','open','app','server','page label','mode','provider','bridge','session store','resize','DPR','visibility','pagehide','blur','navigation','hashchange','detach','hidden host','show launcher','tab mode','inert host'] as const)('%s invalidates a latched result and leaves no late wake or capture',async action=>{
    enabled(); const m=mount({'capture-mode':'viewport'}),capture=provider(m);
    vi.advanceTimersByTime(5000); holdStart(); vi.advanceTimersByTime(700);
    expect(m.root.querySelector<HTMLElement>('.fb-wake-hint')!.hidden).toBe(false);
    if(action==='close') m.widget.close();
    if(action==='open') m.widget.open();
    if(action==='app') m.widget.appId='new';
    if(action==='server') m.widget.apiBase='http://other-api.test';
    if(action==='page label') m.widget.pageLabel='new-page';
    if(action==='mode') m.widget.captureMode='off';
    if(action==='provider') m.widget.captureProvider=vi.fn(()=>new Promise<never>(()=>{}));
    if(action==='bridge') m.widget.hostBridge={};
    if(action==='session store') m.widget.sessionStore={loadSession:()=>null,saveSession:()=>{},clearSession:()=>{}};
    if(action==='hidden host') m.widget.hidden=true;
    if(action==='show launcher') m.widget.showLauncher=false;
    if(action==='tab mode') m.widget.launcherMode='tab';
    if(action==='inert host') m.widget.setAttribute('inert','');
    if(action==='resize') {vi.spyOn(window,'innerWidth','get').mockReturnValue(800); window.dispatchEvent(new Event('resize'));}
    if(action==='DPR') {vi.spyOn(window,'devicePixelRatio','get').mockReturnValue(2); window.dispatchEvent(new Event('resize'));}
    if(action==='visibility') {vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'));}
    if(action==='pagehide') window.dispatchEvent(new Event('pagehide'));
    if(action==='blur') window.dispatchEvent(new Event('blur'));
    if(action==='navigation') window.dispatchEvent(new Event('popstate'));
    if(action==='hashchange') window.dispatchEvent(new Event('hashchange'));
    if(action==='detach') m.widget.remove();
    release(); vi.advanceTimersByTime(1500); await settle();
    expect(capture).not.toHaveBeenCalled(); expect(m.root.querySelector<HTMLElement>('.fb-wake-hint')!.hidden).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(true);
  });
  it.each(['input','button','a','textarea','select','editable','own UI'] as const)('ignores %s starts',async kind=>{
    enabled(); const m=mount({'capture-mode':'viewport'}),capture=provider(m);
    const node=kind==='own UI'?m.orb:document.createElement(kind==='editable'?'div':kind);
    if(kind==='editable') node.setAttribute('contenteditable','true');
    if(kind!=='own UI') document.body.append(node);
    vi.advanceTimersByTime(5000);
    const ps=points(); touch('touchstart',ps,ps,node); vi.advanceTimersByTime(700); touch('touchend',[],ps,node); await settle();
    expect(capture).not.toHaveBeenCalled(); expect(m.orb.classList.contains('is-collapsed')).toBe(true);
  });
  it('cancel preserves original text, capture attachment ID and bytes; confirm alone replaces it and opens the real panel',async()=>{
    enabled(); const m=mount({'capture-mode':'viewport'}),capture=provider(m);
    await m.widget.retakeScreenshot(); setTextarea(m,'原有草稿'); m.widget.close();
    const cell=m.root.querySelector<HTMLElement>('.fb-screenshot-thumb-box')!, id=cell.dataset.imageId, src=m.screenshotThumb.src;
    hold(); await settle(); expect(capture).toHaveBeenCalledTimes(1);
    expect(cell.dataset.imageId).toBe(id); expect(m.screenshotThumb.src).toBe(src); expect(m.textarea.value).toBe('原有草稿');
    drag(m); await settle(); expect(capture).toHaveBeenCalledTimes(2);
    m.root.querySelector<HTMLButtonElement>('.fb-region-cancel')!.click();
    expect(cell.dataset.imageId).toBe(id); expect(m.screenshotThumb.src).toBe(src); expect(m.textarea.value).toBe('原有草稿');
    drag(m); await settle(); m.root.querySelector<HTMLButtonElement>('.fb-region-all')!.click(); await settle();
    expect(capture).toHaveBeenCalledTimes(3); expect(m.root.querySelectorAll('.fb-screenshot-thumb-box')).toHaveLength(1);
    expect(cell.dataset.imageId).toBe(id); expect(m.panel.classList.contains('is-open')).toBe(true); expect(m.textarea.value).toBe('原有草稿');
  });
  it('cancelling pending capture ignores late provider completion and cannot reopen selection',async()=>{
    enabled(); const m=mount({'capture-mode':'viewport'});
    let resolve!:(shot:{blob:Blob;width:number;height:number})=>void;
    m.widget.captureProvider=vi.fn(()=>new Promise<{blob:Blob;width:number;height:number}>(r=>{resolve=r;})); drag(m); m.widget.close();
    resolve({blob:new Blob([encodePng(40,30,new Uint8ClampedArray(40*30*4))],{type:'image/png'}),width:40,height:30});
    await settle(); expect(m.root.querySelector<HTMLElement>('.fb-region-overlay')!.hidden).toBe(true); expect(m.panel.classList.contains('is-open')).toBe(false); expect(m.screenshotWrap.hidden).toBe(true);
  });
});
