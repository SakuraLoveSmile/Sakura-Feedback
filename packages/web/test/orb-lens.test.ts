import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbLens } from '../src/orb-lens';
import { OrbLiquid } from '../src/orb-liquid';
import '../src/index';
import * as capture from '../src/capture';
import { cleanup, mount } from './helpers';
import { blobToPng, encodePng } from './pixel-fixture';

function gpu() {
  let constant=1;
  const values=new Map<string,unknown>();
  const constants=new Map<string,number>();
  const calls=new Map<string,ReturnType<typeof vi.fn>>();
  const gl=new Proxy({}, {get(_target,name:string) {
    if (/^[A-Z_0-9]+$/.test(name)) {
      if (!constants.has(name)) constants.set(name,constant++);
      return constants.get(name);
    }
    if (!calls.has(name)) calls.set(name,vi.fn((...args:unknown[]) => {
      if (name.startsWith('create')) return {type:name};
      if (name==='getShaderParameter' || name==='getProgramParameter') return true;
      if (name==='getAttribLocation') return 0;
      if (name==='getUniformLocation') return args[1];
      if (name==='isContextLost') return false;
      if (name==='getError') return gl.NO_ERROR;
      if (name.startsWith('uniform')) values.set(args[0] as string,args.slice(1));
    }));
    return calls.get(name);
  }}) as WebGLRenderingContext;
  const canvas=document.createElement('canvas');
  vi.spyOn(canvas,'getContext').mockReturnValue(gl);
  return {gl,canvas,values,calls};
}

afterEach(cleanup);

describe('WebGL lens resource and coordinate contract',()=>{
  it('R7 forwards capsule/mist uniforms through the actual draw call while legacy calls stay clear',()=>{
    const {canvas,values}=gpu(),lens=OrbLens.create(canvas)!;
    lens.draw({x:9,y:100},28,new OrbLiquid(),.5,true,{halfSize:{x:6,y:28},handleMix:1,mist:.74,idleMix:1});
    expect(values.get('uHalfSize')).toEqual([6,28]);
    expect(values.get('uHandleMix')).toEqual([1]); expect(values.get('uMist')).toEqual([.74]); expect(values.get('uIdleMix')).toEqual([1]);
    lens.draw({x:200,y:150},52,new OrbLiquid());
    expect(values.get('uHalfSize')).toEqual([52,52]);
    for(const name of ['uHandleMix','uMist','uIdleMix']) expect(values.get(name)).toEqual([0]);
    lens.dispose();
  });
  it('draw scale is independent of capture scale, transparent compositing and uncut 1.6R box',()=>{
    const {canvas,gl,values,calls}=gpu();
    vi.spyOn(window,'devicePixelRatio','get').mockReturnValue(3);
    const lens=OrbLens.create(canvas)!;
    expect(lens).not.toBeNull();
    lens.setImage(document.createElement('canvas'),600,400,800);
    const liquid=new OrbLiquid(); liquid.dirX=0; liquid.dirY=1; liquid.deform=.8; liquid.wobble=.2;
    lens.draw({x:200,y:150},52,liquid);
    expect(values.get('uImageSize')).toEqual([600,400]);
    expect(values.get('uScale')).toEqual([.75]);
    expect(values.get('uLocalSize')).toEqual([166.4,166.4]);
    expect((values.get('uDrawScale') as number[])[0]).toBeCloseTo(Math.ceil(166.4*2)/166.4,10);
    expect(values.get('uOffset')).toEqual([116.8,66.8]);
    expect(values.get('uCenter')).toEqual([200,150]);
    expect(values.get('uDirection')).toEqual([0,1]);
    expect((values.get('uDeform') as number[])[0]).toBeCloseTo(.8*.72,10); expect(values.get('uWobble')).toEqual([.2]);
    expect(values.has('uMode2')).toBe(false);
    expect(values.get('uMagnification')).toEqual([1.62]); expect(values.get('uRimStrength')).toEqual([.64]);
    expect(values.get('uDark')).toEqual([0]);
    expect(values.get('uHasImage')).toEqual([1]);
    expect(calls.get('pixelStorei')).toHaveBeenCalledWith(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    expect(calls.get('pixelStorei')).toHaveBeenCalledWith(gl.UNPACK_FLIP_Y_WEBGL,false);
    expect(calls.get('blendFunc')).toHaveBeenCalledWith(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    lens.clearImage(); lens.draw({x:200,y:150},28,liquid);
    expect(values.get('uHasImage')).toEqual([0]);
    lens.dispose(); lens.dispose();
    expect(calls.get('deleteTexture')).toHaveBeenCalledTimes(1);
    expect(calls.get('deleteBuffer')).toHaveBeenCalledTimes(1);
    expect(calls.get('deleteProgram')).toHaveBeenCalledTimes(1);
    expect(calls.get('deleteShader')).toHaveBeenCalledTimes(2);
    const draws=calls.get('drawArrays')!.mock.calls.length;
    lens.draw({x:0,y:0},52,liquid);
    expect(calls.get('drawArrays')).toHaveBeenCalledTimes(draws);
  });

  it('shader failure releases allocated GPU resources and safely returns no lens',()=>{
    const {canvas,gl,calls}=gpu();
    gl.getShaderParameter(gl.createShader(gl.VERTEX_SHADER)!,gl.COMPILE_STATUS);
    calls.get('getShaderParameter')!.mockReturnValue(false);
    expect(OrbLens.create(canvas)).toBeNull();
    expect(calls.get('deleteTexture')).toHaveBeenCalledTimes(1);
    expect(calls.get('deleteBuffer')).toHaveBeenCalledTimes(1);
    expect(calls.get('deleteProgram')).toHaveBeenCalledTimes(1);
    expect(calls.get('deleteShader')).toHaveBeenCalledTimes(1);
  });
});

interface ShaderMath {
  sourceBend(r:number):number;
  sourcePoint(point:number,offset:number,r:number):number;
  capsuleRadius(x:number,y:number):number;
  gaussianWeight(index:number):number;
  safeUv(point:number,scale:number,size:number):number;
  dispersionWidth(r:number):number;
  glassWhiteMix(r:number,theta:number):number;
  shadeGlass(color:number,r:number,theta:number):number;
  compositeGlass(color:number,inside:number,r:number,theta:number):[number,number];
}

/** Execute the uploaded shader's scalar/color-channel math, without a browser or a GPU.
 * These GLSL helpers use component-wise RGB operations, so each channel is exactly scalar.
 * This checks their behavior rather than reimplementing the production optics in a test mock.
 */
function shaderMath(source:string, values:Map<string,unknown>, channel:number):ShaderMath {
  const names=['sq','safeUv','gaussianWeight','capsuleRadius','sourceBend','sourcePoint','dispersionWidth','glassWhiteMix','idleSheen','clearIdleShine','clearIdleHighlight','clearIdleShadow','clearIdleGlass','shadeGlass','compositeGlass'];
  const functions=names.map(name=>{
    const match=source.match(new RegExp(`(?:float|vec3|vec4) ${name}\\(([^)]*)\\) \\{([^}]+)\\}`));
    if(!match) throw new Error(`Shader math function missing: ${name}`);
    const args=match[1]!.split(',').map(arg=>arg.trim().split(/\s+/).at(-1)).join(',');
    const body=match[2]!
      .replace(/vec3\(([-\d.,\s]+)\)/g,(_whole:string,components:string)=>`(${components.split(',')[channel]!.trim()})`)
      .replace(/\b(?:float|vec3)\s+/g,'let ')
      .replace('return vec4(rgb,alpha);','return [rgb,alpha];');
    return `function ${name}(${args}) {${body}}`;
  }).join('\n');
  const uniforms=['uMagnification','uRimStrength','uHasImage','uOpacity','uDark','uRadius','uHalfSize','uHandleMix','uMist','uIdleMix'];
  const mix=(a:number,b:number,t:number)=>a+(b-a)*t;
  const clamp=(x:number,a:number,b:number)=>Math.max(a,Math.min(b,x));
  return Function(...uniforms,'pow','exp','cos','sin','sqrt','max','mix','clamp','smoothstep',`${functions}\nreturn {${names.join(',')}};`)(
    ...uniforms.map(name=>name==='uHalfSize'?{x:(values.get(name) as number[])[0],y:(values.get(name) as number[])[1]}:(values.get(name) as number[])[0]),Math.pow,Math.exp,Math.cos,Math.sin,Math.sqrt,Math.max,mix,clamp,(a:number,b:number,x:number)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);},
  ) as ShaderMath;
}
function fragment(calls:ReturnType<typeof gpu>['calls']):string {
  return calls.get('shaderSource')!.mock.calls.map(call=>call[1] as string).find(source=>source.includes('gl_FragColor'))!;
}
function referenceShade(color:number,channel:number,r:number,theta:number,dark:boolean):number {
  const sq=(x:number)=>x*x;
  const light=.55+.45*Math.cos(theta+2.25);
  const rim=Math.exp(-sq((r-.992)/.012)), inner=Math.exp(-sq((r-.943)/.030));
  const caustic=Math.exp(-sq((r-.84)/.095))*(.5+.5*Math.sin(theta-.6));
  const shadow=Math.exp(-sq((r-.973)/.018))*(1-light);
  const mix=rim*(.28+.5*light)*.64+inner*.10*light+caustic*.12;
  return color*(1-shadow*.19)*(1-mix)+[.99,.995,1][channel]!*mix+[.002,.003,.009][channel]!*(dark?.5:1);
}

describe('R3 first-preview uploaded shader math',()=>{
  it('actual source sampling grows through the outer ring, with preview dispersion and the original offset',()=>{
    const {canvas,values,calls}=gpu(), lens=OrbLens.create(canvas)!;
    lens.draw({x:200,y:150},52,new OrbLiquid());
    const source=fragment(calls), math=shaderMath(source,values,0);
    let previous=0;
    for(let i=1;i<=1100;i++) {
      const r=i/1000, sampledX=200+52*r*math.sourceBend(r);
      expect(sampledX).toBeGreaterThan(previous); previous=sampledX;
      expect(math.sourcePoint(200+52*r,52*r,r)).toBeCloseTo(sampledX,12);
      expect(math.dispersionWidth(r)).toBeCloseTo(.52*Math.min(r,1)**8,12);
    }
    expect(math.sourceBend(0)).toBeCloseTo(1/1.62,12);
    expect(math.sourceBend(1)).toBeCloseTo(1/1.62+.54,12);
    expect(math.dispersionWidth(1)).toBe(.52);
    lens.dispose();
  });
  it.each([false,true])('restores light, thin rings, caustics, shadow and cold tint for dark=%s',dark=>{
    const {canvas,values,calls}=gpu(), lens=OrbLens.create(canvas)!;
    lens.setImage(document.createElement('canvas'),400,300,400);
    lens.draw({x:200,y:150},52,new OrbLiquid(),1,dark);
    expect(values.get('uDark')).toEqual([dark?1:0]);
    for(let channel=0;channel<3;channel++) {
      const math=shaderMath(fragment(calls),values,channel);
      for(const r of [0,.4,.72,.84,.90,.943,.973,.992,1,1.04]) for(const theta of [-Math.PI,-2.25,-.6,0,Math.PI/2,Math.PI]) {
        expect(math.shadeGlass(.34,r,theta)).toBeCloseTo(referenceShade(.34,channel,r,theta,dark),12);
      }
    }
    lens.dispose();
  });
  it('transparent premultiplied composition equals the original full-canvas formula at partial coverage and opacity',()=>{
    const {canvas,values,calls}=gpu(), lens=OrbLens.create(canvas)!;
    lens.setImage(document.createElement('canvas'),400,300,400);
    for(const opacity of [1,.37]) {
      lens.draw({x:200,y:150},52,new OrbLiquid(),opacity);
      for(let channel=0;channel<3;channel++) {
        const math=shaderMath(fragment(calls),values,channel);
        const background=[.19,.37,.62][channel]!, glass=[.7,.2,.4][channel]!, glowColor=[.95,.965,1][channel]!;
        for(const r of [.98,1,1.04,1.1]) for(const inside of [0,.1,.5,.99,1]) {
          const [rgb,alpha]=math.compositeGlass(glass,inside,r,.5);
          const glow=Math.exp(-(((r-1.04)/.065)**2))*.055;
          const originalBackground=background+(glowColor-background)*glow*(1-inside);
          const original=originalBackground+(glass-originalBackground)*inside;
          const composed=rgb+background*(1-alpha);
          expect(composed).toBeCloseTo(background+(original-background)*opacity,12);
          expect(alpha).toBeCloseTo((inside+glow*(1-inside)**2)*opacity,12);
        }
      }
    }
    lens.dispose();
  });
  it('white safe-texture samples stay premultiplied through cold tint, partial opacity and edge coverage',()=>{
    const {canvas,values,calls}=gpu(), lens=OrbLens.create(canvas)!;
    // The GPU mock uploads the safe texture; its known white RGB sample is 1 per channel.
    lens.setImage(document.createElement('canvas'),400,300,400);
    for(const dark of [false,true]) for(const opacity of [.5,.37,1,0]) {
      lens.draw({x:200,y:150},52,new OrbLiquid(),opacity,dark);
      expect(values.get('uHasImage')).toEqual([1]);
      for(const channel of [2,0,1]) {
        const math=shaderMath(fragment(calls),values,channel);
        for(const r of [0,.84,.943,.973,.992,1,1.04]) for(const inside of [1,.5,0]) {
          const white=math.shadeGlass(1,r,0);
          const [rgb,alpha]=math.compositeGlass(white,inside,r,0);
          expect(rgb).toBeGreaterThanOrEqual(0);
          expect(rgb).toBeLessThanOrEqual(alpha);
          expect(alpha).toBeGreaterThanOrEqual(0);
          expect(alpha).toBeLessThanOrEqual(opacity);
        }
      }
    }
    lens.dispose();
  });
  it('outer glow has its own color and never borrows sampled glass; missing texture stays a transparent safe edge',()=>{
    const {canvas,values,calls}=gpu(), lens=OrbLens.create(canvas)!;
    lens.setImage(document.createElement('canvas'),400,300,400); lens.draw({x:200,y:150},52,new OrbLiquid());
    for(let channel=0;channel<3;channel++) {
      const math=shaderMath(fragment(calls),values,channel);
      expect(math.compositeGlass(0,0,1.04,0)).toEqual(math.compositeGlass(1,0,1.04,0));
      expect(math.compositeGlass(0,0,1.04,0)[0]).toBeCloseTo([.95,.965,1][channel]!*.055,12);
    }
    lens.clearImage(); lens.draw({x:200,y:150},52,new OrbLiquid());
    for(let channel=0;channel<3;channel++) {
      const math=shaderMath(fragment(calls),values,channel);
      expect(math.compositeGlass(1,1,0,0)[1]).toBeLessThan(1e-20);
      const edge=math.compositeGlass(1,1,.992,0);
      expect(edge[1]).toBeGreaterThan(0); expect(edge[1]).toBeLessThan(1);
      expect(edge).toEqual(math.compositeGlass(0,1,.992,0));
    }
    lens.dispose();
  });
  it.each([false,true])('mounted clear drag retains at least .85 of internal text contrast for dark=%s',async dark=>{
    const {gl,values,calls}=gpu();
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(gl);
    const texture=new Blob([encodePng(2,1,new Uint8ClampedArray([31,31,31,255,224,224,224,255]))],{type:'image/png'});
    const close=vi.fn();
    vi.stubGlobal('createImageBitmap',async(blob:Blob)=>({...await blobToPng(blob),close}));
    vi.spyOn(capture,'captureViewport').mockResolvedValue({blob:texture,viewportWidth:1024,viewportHeight:768,outputWidth:2,outputHeight:1,maskedRegions:[]});
    vi.stubGlobal('matchMedia',(media:string)=>({matches:media==='(prefers-reduced-motion: reduce)',media,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    const m=mount({'launcher-mode':'orb',theme:dark?'dark':'light'});
    await vi.waitFor(()=>expect(values.get('uHasImage')).toEqual([1]));
    expect(close).toHaveBeenCalledTimes(1);
    expect(calls.get('texImage2D')!.mock.calls.at(-1)!.at(-1)).toMatchObject({width:2,height:1,data:new Uint8ClampedArray([31,31,31,255,224,224,224,255])});
    expect(values.get('uMist')).toEqual([.74]);
    for(const [type,x] of [['pointerdown',100],['pointermove',140]] as const) m.orb.dispatchEvent(new PointerEvent(type,{bubbles:true,composed:true,button:0,isPrimary:true,pointerId:1,clientX:x,clientY:100}));
    expect(m.orb.classList.contains('is-dragging')).toBe(true);
    expect(values.get('uMist')).toEqual([0]); expect(values.get('uIdleMix')).toEqual([0]);
    expect(values.get('uHasImage')).toEqual([1]);
    const originalContrast=.88-.12;
    for(let channel=0;channel<3;channel++) {
      const math=shaderMath(fragment(calls),values,channel);
      for(let r=0;r<=.75;r+=.01) for(let theta=-Math.PI;theta<=Math.PI;theta+=.2) {
        const contrast=math.shadeGlass(.88,r,theta)-math.shadeGlass(.12,r,theta);
        expect(contrast/originalContrast).toBeGreaterThanOrEqual(.85);
      }
    }
    m.orb.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:1}));
  });
});

/** Evaluate the uploaded bounded sampler for one RGB channel, using the existing
 * shader-math approach. Sampling records real logical offsets and the shader's
 * safeUv helper; this is software evidence, not a claim of hardware GPU execution.
 */
function mistSampler(source:string,math:ShaderMath,mist:number,sample:(p:{x:number;y:number})=>number,dark=false) {
  const body=(name:string)=>{
    const start=source.indexOf(`vec3 ${name}(vec2 p) {`);
    if(start<0) throw new Error(`Missing uploaded sampler ${name}`);
    let end=source.indexOf('{',start)+1,depth=1;
    const first=end;
    for(;end<source.length && depth;end++) {if(source[end]==='{') depth++;if(source[end]==='}') depth--;}
    return source.slice(first,end-1)
      .replace(/p\+vec2\(float\(([^)]+)\),float\(([^)]+)\)\)\*([\d.]+)/g,'offset(p,($1)*($3),($2)*($3))')
      .replace(/p\+vec2\(([-.\d]+),([-.\d]+)\)/g,'offset(p,$1,$2)')
      .replace(/vec3\(0\.\)/g,'0').replace(/\b(?:vec3|int)\s+/g,'let ');
  };
  return Function('sampleBg','gaussianWeight','offset','uMist','uHasImage','uDark','uIdleMix','mix',`function sampleClearIdle(p){${body('sampleClearIdle')}}; function sampleMist(p){${body('sampleMist')}}; return function(p){${body('sampleGlass')}}`)(
    sample,math.gaussianWeight,(p:{x:number;y:number},x:number,y:number)=>({x:p.x+x,y:p.y+y}),mist,1,dark?1:0,1,(a:number,b:number,t:number)=>a+(b-a)*t,
  ) as (p:{x:number;y:number})=>number;
}

describe('R11 confirmed clear-glass standby material',()=>{
  it('preserves the background with a restrained local reflection and a low-alpha texture-free cue',()=>{
    const {canvas,values,calls}=gpu(),lens=OrbLens.create(canvas)!;
    lens.setImage(document.createElement('canvas'),400,300,400);
    for(const material of [{halfSize:{x:28,y:28},handleMix:0},{halfSize:{x:5,y:24},handleMix:1}]) {
      lens.draw({x:100,y:100},28,new OrbLiquid(),1,true,{...material,mist:.74,idleMix:1});
      for(let channel=0;channel<3;channel++) {
        const math=shaderMath(fragment(calls),values,channel);
        const center=math.shadeGlass(.4,0,0);
        expect(center).toBeGreaterThan(.39); expect(center).toBeLessThan(.42);
        expect(math.shadeGlass(.88,.5,0)-math.shadeGlass(.12,.5,0)).toBeGreaterThan(.72);
        expect(math.shadeGlass(.1,.985,-2.3)).toBeGreaterThan(math.shadeGlass(.1,.985,.85));
        expect(math.sourceBend(0)).toBeCloseTo(.61,12); expect(math.sourceBend(1)).toBeCloseTo(1.07,12);
        expect(math.dispersionWidth(1)).toBe(0);
        const [rgb,alpha]=math.compositeGlass(0,0,1+2/material.halfSize.x,0);
        expect(alpha).toBeCloseTo(.11*Math.exp(-((2/4.5)**2)),12);
        // On the chosen dark surface the exterior remains subtle, not a white halo.
        expect(Math.abs(rgb+18/255*(1-alpha)-18/255)).toBeLessThan(8/255);
      }
    }
    lens.clearImage(); lens.draw({x:100,y:100},28,new OrbLiquid(),1,true,{mist:.74,idleMix:1});
    for(let channel=0;channel<3;channel++) {
      const math=shaderMath(fragment(calls),values,channel);
      const [rgb,alpha]=math.compositeGlass(1,1,0,0);
      expect(alpha).toBeCloseTo(.016,12);
      expect(rgb/alpha).toBeCloseTo([132,137,153][channel]!/255,12);
    }
    lens.dispose();
  });
  it('uses only five taps within0.35 logical pixels for dark standby, while preserving the sample constant',()=>{
    const {canvas,values,calls}=gpu(),lens=OrbLens.create(canvas)!;
    lens.setImage(document.createElement('canvas'),400,300,400);
    lens.draw({x:100,y:100},28,new OrbLiquid(),1,true,{mist:.74,idleMix:1});
    const source=fragment(calls),math=shaderMath(source,values,0),taps:{x:number;y:number}[]=[];
    const sampler=mistSampler(source,math,.74,p=>{taps.push(p);return p.x===100 && p.y===100?1:0;},true);
    expect(sampler({x:100,y:100})).toBe(.5);
    expect(taps).toHaveLength(5);
    expect(taps).toEqual([{x:100,y:100},{x:99.65,y:100},{x:100.35,y:100},{x:100,y:99.65},{x:100,y:100.35}]);
    expect(mistSampler(source,math,.74,()=>.41,true)({x:100,y:100})).toBeCloseTo(.41,12);
    lens.dispose();
  });
});

describe('R7 uploaded safe mist and capsule behavior',()=>{
  it('R9 light idle halo stays visible2–6px outside on white and pale gray, with a soft fade for sphere and capsule',()=>{
    const {canvas,values,calls}=gpu(),lens=OrbLens.create(canvas)!;
    for(const material of [{halfSize:{x:28,y:28},handleMix:0},{halfSize:{x:6,y:28},handleMix:1}]) {
      lens.draw({x:100,y:100},28,new OrbLiquid(),1,false,{...material,mist:.74,idleMix:1});
      const channels=[0,1,2].map(channel=>shaderMath(fragment(calls),values,channel));
      for(const background of [[1,1,1],[243/255,244/255,250/255]]) {
        const delta=(distance:number)=>Math.max(...channels.map((math,channel)=>{
          const [rgb,alpha]=math.compositeGlass(0,0,1+distance/material.halfSize.x,0);
          return Math.abs(rgb+background[channel]!*(1-alpha)-background[channel]!);
        }));
        const near=delta(2),middle=delta(4),far=delta(6);
        expect(near).toBeGreaterThan(12/255);
        expect(far).toBeGreaterThan(4/255);
        expect(near).toBeGreaterThan(middle); expect(middle).toBeGreaterThan(far);
        expect(far/near).toBeGreaterThan(.15);
        for(let distance=2;distance<6;distance+=.25) {
          expect(Math.abs(delta(distance)-delta(distance+.25))).toBeLessThan(3/255);
        }
      }
    }
    lens.dispose();
  });
  it('uses exactly25 bounded gaussian taps only for mist, preserves constants and changes a sharp impulse',()=>{
    const {canvas,values,calls}=gpu(),lens=OrbLens.create(canvas)!;
    lens.setImage(document.createElement('canvas'),400,300,400);
    lens.draw({x:100,y:100},28,new OrbLiquid(),1,false,{mist:.74,idleMix:1});
    const source=fragment(calls),math=shaderMath(source,values,0),taps:{x:number;y:number}[]=[];
    const sample=(p:{x:number;y:number})=>{taps.push(p);return p.x===100 && p.y===100?1:0;};
    expect(mistSampler(source,math,0,sample)({x:100,y:100})).toBe(1); expect(taps).toHaveLength(1);
    taps.length=0;
    const blurred=mistSampler(source,math,.74,sample)({x:100,y:100});
    expect(taps).toHaveLength(26); // one clear sample plus the frozen5×5 kernel
    expect(new Set(taps.map(p=>p.x))).toEqual(new Set([90,95,100,105,110]));
    expect(new Set(taps.map(p=>p.y))).toEqual(new Set([90,95,100,105,110]));
    expect(blurred).toBeCloseTo(.26+.74*.40262**2,12); expect(1-blurred).toBeGreaterThan(.5);
    expect(mistSampler(source,math,.74,()=>.41)({x:100,y:100})).toBeCloseTo(.41,12);
    for(const p of [{x:-100,y:-100},{x:500,y:400}]) {
      const uvs:{x:number;y:number}[]=[];
      mistSampler(source,math,.74,point=>{const uv={x:math.safeUv(point.x,1,400),y:math.safeUv(point.y,1,300)};uvs.push(uv);return uv.x;})(p);
      expect(uvs).toHaveLength(26);
      for(const uv of uvs) {
        expect(uv.x).toBeGreaterThanOrEqual(.5/400); expect(uv.x).toBeLessThanOrEqual(1-.5/400);
        expect(uv.y).toBeGreaterThanOrEqual(.5/300); expect(uv.y).toBeLessThanOrEqual(1-.5/300);
      }
    }
    lens.dispose();
  });
  it.each([false,true])('complete12×56 capsule has straight sides, correct source direction and premultiplied output, dark=%s',dark=>{
    const {canvas,values,calls}=gpu(),lens=OrbLens.create(canvas)!;
    lens.setImage(document.createElement('canvas'),400,300,400);
    for(const opacity of [0,.37,.5,1]) {
      lens.draw({x:9,y:100},28,new OrbLiquid(),opacity,dark,{halfSize:{x:6,y:28},handleMix:1,mist:.74,idleMix:1});
      for(let channel=0;channel<3;channel++) {
        const math=shaderMath(fragment(calls),values,channel);
        for(const y of [-22,-12,0,12,22]) {expect(math.capsuleRadius(6,y)).toBe(1);expect(math.capsuleRadius(-6,y)).toBe(1);}
        expect(math.capsuleRadius(0,28)).toBe(1); expect(math.capsuleRadius(0,-28)).toBe(1);
        expect(math.capsuleRadius(0,0)).toBe(0);
        // Straight stem has no vertical refraction offset; the source remains on its own row.
        expect(math.sourcePoint(112,0,1)).toBe(112);
        expect(math.sourcePoint(15,6,1)).toBeGreaterThan(15);
        for(const r of [0,.8,.91,.943,.973,.992,1,1.04,1.15]) for(const inside of [0,.5,1]) {
          const [rgb,alpha]=math.compositeGlass(math.shadeGlass(1,r,.4),inside,r,.4);
          expect(rgb).toBeGreaterThanOrEqual(0); expect(rgb).toBeLessThanOrEqual(alpha);
          expect(alpha).toBeLessThanOrEqual(opacity);
        }
      }
    }
    lens.clearImage(); lens.draw({x:9,y:100},28,new OrbLiquid(),1,dark,{halfSize:{x:6,y:28},handleMix:1,mist:.74,idleMix:1});
    const math=shaderMath(fragment(calls),values,0);
    // R11 replaces the rejected smoke with a clear low-alpha body and local rim.
    const centerAlpha=math.compositeGlass(1,1,0,0)[1];
    expect(centerAlpha).toBeGreaterThanOrEqual(0); expect(centerAlpha).toBeLessThan(.05);
    expect(math.compositeGlass(1,1,1-.35/6,0)[1]).toBeLessThan(.25);
    if(!dark) {
      expect(centerAlpha).toBe(0);
      expect(math.compositeGlass(1,0,1.04,0)[1]).toBeCloseTo(.18,12);
    }
    expect(math.compositeGlass(1,0,1.18,0)[1]).toBeGreaterThan(.03);
    lens.dispose();
  });
});
