/** Local launcher appearance only; no host configuration or capture authority. */
import { liquidBoundary, type LiquidShape } from './orb-liquid';

export type OrbIdleStyle = 'handle' | 'edge';

export interface OrbIdleVisual {
  x: number;
  halfX: number;
  halfY: number;
  handleMix: number;
  hitX: number;
  hitWidth: number;
  clipLeft: number;
  clipRight: number;
}

/** Interruptible, finite420ms morph; the caller owns generation/lifecycle guards. */
export function interpolateOrbIdle(from: OrbIdleVisual, to: OrbIdleVisual, elapsed: number): OrbIdleVisual {
  const p=Math.max(0,Math.min(1,elapsed/420)),e=1-(1-p)**3;
  const result={...to};
  for (const key of Object.keys(to) as (keyof OrbIdleVisual)[]) result[key]=from[key]+(to[key]-from[key])*e;
  return result;
}

/** Constrain the interpolated hit rectangle to the visible neutral R7 contour.
 * This never moves the glass/sampler center. At y=0 the mixed r=1 extent is
 * harmonic, not the interpolated halfSize; every other row fits within it.
 */
export function constrainOrbIdleHit(visual: OrbIdleVisual, viewportWidth: number, safeLeft: number, safeRight: number): OrbIdleVisual {
  const radius=28,size=radius*3.2,boxLeft=visual.x-size/2;
  const clipLeft=Math.min(1,Math.max(visual.clipLeft,(safeLeft-boxLeft)/size,0));
  const clipRight=Math.min(1,Math.max(visual.clipRight,(boxLeft+size-(viewportWidth-safeRight))/size,0));
  const extent=1/((1-visual.handleMix)/radius+visual.handleMix/visual.halfX);
  const visibleLeft=Math.max(visual.x-extent,boxLeft+size*clipLeft);
  const visibleRight=Math.min(visual.x+extent,boxLeft+size*(1-clipRight));
  const hitWidth=Math.max(visual.hitWidth,Math.min(56,Math.max(0,visibleRight-visibleLeft)));
  const hitLeft=Math.max(visibleRight-hitWidth,Math.min(visual.hitX-hitWidth/2,visibleLeft));
  return {...visual,clipLeft,clipRight,hitX:hitLeft+hitWidth/2,hitWidth};
}

/** Same implicit sphere/capsule blend as the shader, for the texture-free outline. */
export function orbIdleBoundary(theta: number, radius: number, shape: LiquidShape, visual: OrbIdleVisual): number {
  const sphere=radius*liquidBoundary(theta,shape);
  if (visual.handleMix===0) return sphere;
  const c=Math.cos(theta),s=Math.sin(theta),stem=Math.max(0,visual.halfY-visual.halfX);
  let lo=0,hi=Math.max(sphere,visual.halfY)*2;
  for (let i=0;i<24;i++) {
    const mid=(lo+hi)/2,y=mid*s;
    const capsule=Math.hypot(mid*c,y-Math.max(-stem,Math.min(stem,y)))/visual.halfX;
    if ((1-visual.handleMix)*mid/sphere+visual.handleMix*capsule<1) lo=mid;
    else hi=mid;
  }
  return (lo+hi)/2;
}

export function orbIdlePreferenceKey(appId: string): string {
  return `feedback:orb-idle:v1:${encodeURIComponent(appId)}`;
}

export function parseOrbIdlePreference(value: string | null): OrbIdleStyle {
  try {
    const data: unknown = JSON.parse(value ?? 'null');
    if (data && typeof data === 'object' && 'version' in data && data.version === 1 && 'style' in data && (data.style === 'handle' || data.style === 'edge')) return data.style;
  } catch { /* Invalid local values use the default. */ }
  return 'handle';
}
