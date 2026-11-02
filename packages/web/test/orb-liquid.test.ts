import { describe, it, expect } from 'vitest';
import { OrbLiquid, lensSourceRadius, liquidBoundary } from '../src/orb-liquid';

describe('first-preview directional dynamics and R3 optics', () => {
  // The user's R3 selection replaces the obsolete reverse-annulus requirement.
  it('samples continuously outwards from the magnified center through the first-preview edge', () => {
    expect(lensSourceRadius(0)).toBe(0);
    expect(lensSourceRadius(.00001)/.00001).toBeCloseTo(1/1.62,12);
    expect(lensSourceRadius(.75)).toBeCloseTo(.517,3);
    expect(lensSourceRadius(.86)).toBeCloseTo(.692,3);
    expect(lensSourceRadius(1)).toBeCloseTo(1/1.62+.54,12);
    let previous = lensSourceRadius(0);
    for (let r=.001;r<=1.6;r+=.001) {
      const current=lensSourceRadius(r); expect(current).toBeGreaterThan(previous); previous=current;
    }
    expect(lensSourceRadius(1.1)).toBeCloseTo(1.1*(1/1.62+.54),12);
  });

  // R2 explicitly replaces R1 independent Fourier spring modes with the original directional contour.
  it('stretches in the velocity direction, keeps the preview cap and grows the drag radius', () => {
    const liquid=new OrbLiquid(); liquid.reset(10,20); liquid.tx=500;
    for (let i=0;i<12;i++) liquid.advance(1/60,true);
    expect(liquid.dirX).toBeCloseTo(1,10); expect(liquid.dirY).toBe(0);
    expect(liquid.deform).toBeGreaterThan(.4); expect(liquid.deform).toBeLessThanOrEqual(1.3);
    expect(liquid.radius).toBeGreaterThan(53); expect(liquid.radius).toBeLessThan(54);
    expect(liquidBoundary(0,liquid)).toBeGreaterThan(liquidBoundary(Math.PI/2,liquid));
    expect(liquid.wobble).toBe(0);
    liquid.advance(.025,false);
    expect(liquid.wobble).toBeCloseTo(Math.sin(.025*23)*Math.exp(-.025*6),10);
    expect(liquid.deform).toBeGreaterThan(0); // release retains velocity-driven deformation
    liquid.advance(0,true); expect(liquid.wobble).toBe(0);
    for (let i=0;i<600&&!liquid.settled;i++) liquid.advance(1/60,false);
    expect(liquid.settled).toBe(true);
    expect([liquid.x,liquid.y,liquid.deform,liquid.wobble,liquid.radius]).toEqual([liquid.tx,liquid.ty,0,0,52]);
  });

  it('fixed integration agrees across frame rates and caps a stalled frame at 32ms', () => {
    const a=new OrbLiquid(),b=new OrbLiquid(),c=new OrbLiquid(),d=new OrbLiquid();
    for (const model of [a,b,c,d]) { model.reset(0,0); model.tx=400; model.ty=100; }
    for (let i=0;i<60;i++) a.advance(1/60,true);
    for (let i=0;i<120;i++) b.advance(1/120,true);
    expect(a.x).toBeCloseTo(b.x,10); expect(a.deform).toBeCloseTo(b.deform,10);
    c.advance(10,true); d.advance(.032,true);
    expect(c.x).toBe(d.x); expect(c.deform).toBe(d.deform);
    a.advance(0,true,true);
    expect([a.x,a.y,a.vx,a.vy,a.deform,a.wobble,a.radius]).toEqual([a.tx,a.ty,0,0,0,0,52]);
  });

  it('CPU radial boundary is the inverse of the original q-space contour in every direction',()=>{
    const shape={dirX:.6,dirY:.8,deform:1.3,wobble:.43};
    for(let i=0;i<128;i++) {
      const theta=i*2*Math.PI/128, boundary=liquidBoundary(theta,shape), stretch=1+shape.deform*.72*.20;
      const x=Math.cos(theta)*boundary,y=Math.sin(theta)*boundary;
      const qx=(x*shape.dirX+y*shape.dirY)/stretch, qy=(-x*shape.dirY+y*shape.dirX)*Math.sqrt(stretch), a=Math.atan2(qy,qx);
      const contour=1+shape.deform*.72*(.045*Math.cos(3*a)-.035*Math.cos(a))+shape.wobble*.028*Math.cos(2*a+.7);
      expect(Math.hypot(qx,qy)/contour).toBeCloseTo(1,12);
    }
    expect(liquidBoundary(1,{dirX:1,dirY:0,deform:0,wobble:0})).toBeCloseTo(1,12);
  });
});
