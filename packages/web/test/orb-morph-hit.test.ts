import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { OrbLens } from '../src/orb-lens';
import { orbIdlePreferenceKey } from '../src/orb-idle';
import { APP_ID, cleanup, mount } from './helpers';

vi.mock('../src/capture',async original=>({...await original<typeof import('../src/capture')>(),captureViewport:vi.fn(async()=>{throw new Error('fixture: safe texture unavailable');})}));

beforeEach(()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(performance,'now').mockImplementation(()=>Date.now());
  vi.stubGlobal('matchMedia',(media:string)=>({matches:false,media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  vi.spyOn(OrbLens,'create').mockReturnValue(null);
  vi.spyOn(window,'innerWidth','get').mockReturnValue(390);
});
afterEach(()=>{cleanup();vi.useRealTimers();});

function scene(side:string,style:string,inset:boolean) {
  localStorage.setItem(orbIdlePreferenceKey(APP_ID),JSON.stringify({version:1,style}));
  let id=0;const frames=new Map<number,FrameRequestCallback>();
  vi.spyOn(window,'requestAnimationFrame').mockImplementation(callback=>{frames.set(++id,callback);return id;});
  vi.spyOn(window,'cancelAnimationFrame').mockImplementation(key=>{frames.delete(key);});
  const host=document.createElement('button'),hostTap=vi.fn(); host.addEventListener('click',hostTap);document.body.append(host);
  const m=mount({side,'launcher-mode':'orb','capture-mode':'viewport'}),provider=vi.fn(()=>new Promise<never>(()=>{}));m.widget.captureProvider=provider;
  const probe=m.root.querySelector<HTMLElement>('.fb-safe-insets')!;
  probe.style.paddingLeft=inset?'32px':'0px';probe.style.paddingRight=inset?'48px':'0px';
  const hit=()=>new DOMRect(parseFloat(m.orb.style.left),250,parseFloat(m.orb.style.width),56);
  vi.spyOn(m.orb,'getBoundingClientRect').mockImplementation(hit);
  m.widget.launcherBottom='31%';
  expect(m.orb.classList.contains('is-unavailable')).toBe(false);
  const dock=hit(),safeLeft=inset?32:0,safeRight=inset?342:390;
  const step=(time:number)=>{vi.setSystemTime(time);const batch=[...frames.values()];frames.clear();for(const callback of batch) callback(time);};
  const face=()=>{
    // Read the actual mounted SVG's r=1 contour, which shares the shader's sphere/capsule equation.
    const svg=m.root.querySelector<SVGSVGElement>('svg.fb-orb-lens')!,size=parseFloat(svg.style.width);
    const left=parseFloat(svg.style.left),top=parseFloat(svg.style.top);
    const points=[...svg.querySelector('path')!.getAttribute('d')!.matchAll(/([\d.e+-]+),([\d.e+-]+)/g)].map(p=>({x:left+Number(p[1]),y:top+Number(p[2])}));
    const clips=svg.style.clipPath.match(/inset\(0 ([\d.e+-]+)% 0 ([\d.e+-]+)%\)/)!;
    const clipLeft=Math.max(0,left+size*Number(clips[2])/100),clipRight=Math.min(390,left+size*(1-Number(clips[1])/100));
    return {center:{x:left+size/2,y:top+size/2},points,clipLeft,clipRight,
      left:Math.max(clipLeft,Math.min(...points.map(p=>p.x))),right:Math.min(clipRight,Math.max(...points.map(p=>p.x)))};
  };
  const tap=(x:number,y=278)=>{
    // happy-dom has no layout hit testing. Route actual pointer coordinates through
    // the mounted DOM/CSS hit box, including its rounded button border. A rectangular
    // child can provide the full declared44–56×56 target without changing that border.
    const rect=hit(),surface=m.orb.querySelector<HTMLElement>('.fb-orb-hit');
    const inRect=x>=rect.left && x<rect.right && y>=rect.top && y<rect.bottom;
    const surfaceStyle=surface?getComputedStyle(surface):null;
    const child=surfaceStyle && surfaceStyle.display!=='none' && surfaceStyle.position==='absolute' && ['top','right','bottom','left'].every(side=>parseFloat(surfaceStyle.getPropertyValue(side))===0);
    if(surface) expect(child).toBeTruthy();
    const inRounded=((x-(rect.left+rect.width/2))/(rect.width/2))**2+((y-(rect.top+28))/28)**2<=1;
    const target=inRect && (child || inRounded)?(surface??m.orb):host;
    for(const type of ['pointerdown','pointerup']) target.dispatchEvent(new PointerEvent(type,{bubbles:true,composed:true,cancelable:true,button:0,isPrimary:true,pointerId:1,clientX:x,clientY:y}));
    target.dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true,cancelable:true,button:0,clientX:x,clientY:y}));
  };
  const exposed=()=>{
    const f=face();
    // Both horizontal opaque-body ends, plus off-center body points, are away from the hit center.
    const points=[{x:f.left+.2,y:278},{x:f.right-.2,y:278},...f.points.filter((_,i)=>i%16===8).map(p=>({x:f.center.x+(p.x-f.center.x)*.98,y:f.center.y+(p.y-f.center.y)*.98}))];
    return points.filter(p=>p.x>f.clipLeft+.1 && p.x<f.clipRight-.1);
  };
  return {...m,provider,hostTap,frames,step,face,hit,dock,safeLeft,safeRight,tap,exposed};
}

describe('R7 visible contour pointer routing',()=>{
  const matrix=['left','right'].flatMap(side=>['handle','edge'].flatMap(style=>[false,true].flatMap(inset=>[false,true].flatMap(expanding=>[42,210,378].map(elapsed=>({side,style,inset,expanding,elapsed}))))));
  it.each(matrix)('$side $style safe=$inset expanding=$expanding at $elapsed ms: actual visible exterior points belong to orb and stale space to host',({side,style,inset,expanding,elapsed})=>{
    const s=scene(side,style,inset);vi.advanceTimersByTime(5000);
    let started=5000;
    if(expanding) {s.step(5420);const f=s.face();s.tap((f.left+f.right)/2);expect(s.hostTap).not.toHaveBeenCalled();started=5420;}
    s.step(started+elapsed);
    const before=s.face(),hit=s.hit();
    expect(hit.width).toBeGreaterThanOrEqual(44);expect(hit.width).toBeLessThanOrEqual(56);expect(hit.height).toBe(56);
    expect(hit.left).toBeGreaterThanOrEqual(s.safeLeft-1e-8);expect(hit.right).toBeLessThanOrEqual(s.safeRight+1e-8);
    expect(before.left).toBeGreaterThanOrEqual(s.safeLeft-1e-8);expect(before.right).toBeLessThanOrEqual(s.safeRight+1e-8);
    const edge=side==='left'?s.safeLeft:s.safeRight;
    const edgeGap=side==='left'?hit.left-edge:edge-hit.right;
    const empty=edgeGap>1e-5?(side==='left'?(edge+hit.left)/2:(edge+hit.right)/2):null;
    const stale=side==='left'?(hit.right+s.dock.right)/2:(hit.left+s.dock.left)/2;
    if(empty!==null) s.tap(empty);
    s.tap(stale);expect(s.hostTap).toHaveBeenCalledTimes(empty===null?1:2);
    const misses=s.hostTap.mock.calls.length;
    for(const point of s.exposed()) {s.tap(point.x,point.y);expect(s.hostTap).toHaveBeenCalledTimes(misses);}
    // Reversing a collapse must not move either the paint or the corrected hit box at that instant.
    expect(s.hit()).toEqual(hit);expect(s.face()).toEqual(before);
    expect(s.provider).not.toHaveBeenCalled();expect(s.panel.classList.contains('is-open')).toBe(false);
    s.step(started+elapsed+420);
    expect(s.hit()).toEqual(s.dock);expect(s.frames.size).toBe(0);expect(s.provider).not.toHaveBeenCalled();
  });
  it.each(['left','right'].flatMap(side=>['handle','edge'].flatMap(style=>[false,true].map(inset=>({side,style,inset})))))('$side $style safe=$inset: repeated exterior wake during reversal is continuous and the next collapse has no old hot zone',({side,style,inset})=>{
    const s=scene(side,style,inset);vi.advanceTimersByTime(5000);s.step(5042);
    const first=s.hit(),face=s.face(),point=s.exposed()[0]!;s.tap(point.x,point.y);
    expect(s.hostTap).not.toHaveBeenCalled();expect(s.hit()).toEqual(first);expect(s.face()).toEqual(face);
    for(const time of [5084,5252,5420]) {
      s.step(time);const hit=s.hit(),face=s.face();
      for(const point of s.exposed()) {s.tap(point.x,point.y);expect(s.hostTap).not.toHaveBeenCalled();}
      expect(s.hit()).toEqual(hit);expect(s.face()).toEqual(face);
    }
    s.step(5462);expect(s.hit()).toEqual(s.dock);expect(s.frames.size).toBe(0);
    vi.advanceTimersByTime(5000);s.step(Date.now()+420);
    const end=s.hit();expect(end.width).toBe(44);expect(end.height).toBe(56);
    expect(side==='left'?end.left:end.right).toBe(side==='left'?s.safeLeft:s.safeRight);
    s.tap(side==='left'?(end.right+s.dock.right)/2:(end.left+s.dock.left)/2);
    expect(s.hostTap).toHaveBeenCalledTimes(1);expect(s.provider).not.toHaveBeenCalled();expect(s.frames.size).toBe(0);
  });
  it('left edge at42ms: the visible x10 point must wake rather than reach the host',()=>{
    const s=scene('left','edge',false);vi.advanceTimersByTime(5000);s.step(5042);
    expect(s.face().center.x).toBeCloseTo(34.992,10);expect(s.face().left).toBeCloseTo(6.992,10);
    s.tap(10);expect(s.hostTap).not.toHaveBeenCalled();expect(s.provider).not.toHaveBeenCalled();
    s.step(5462);expect(s.hit()).toEqual(s.dock);expect(s.panel.classList.contains('is-open')).toBe(false);
  });
});
