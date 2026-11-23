import type { WakePoint } from './wake-gestures';

export const orbEntrances = [
  {id: 'bead', label: '小珠浮现', duration: 320},
  {id: 'join', label: '指尖合珠', duration: 320},
  {id: 'reveal', label: '掠光显形', duration: 250},
  {id: 'dent', label: '按痕浮起', duration: 335},
  {id: 'turn', label: '薄镜翻开', duration: 285},
  {id: 'drop', label: '牵丝成滴', duration: 340},
  {id: 'corners', label: '取景成球', duration: 280},
] as const;
export type OrbEntrance = typeof orbEntrances[number];

export const orbEntranceKey = (app: string) => `feedback:orb-entrance:v1:${encodeURIComponent(app)}`;
export const decodeEntrance = (id: string | null) => orbEntrances.find(effect => effect.id === id) ?? orbEntrances[0];
export function entranceAxis(points: readonly WakePoint[], diameter: number): WakePoint {
  const [first, second] = points;
  if (first && second && points.length === 2) {
    const x = second.x-first.x, y = second.y-first.y, length = Math.hypot(x,y);
    if (length > .001) {
      const scale = Math.max(.2,Math.min(.92,length/diameter))/length;
      return {x:x*scale, y:y*scale};
    }
  }
  return {x:.89, y:-.22};
}

function smooth(x: number): number {
  const t=Math.max(0,Math.min(1,x));
  return t*t*(3-2*t);
}
export function beadGrowth(t: number): number {
  return .12+.905*smooth(t/.75)-.025*smooth((t-.75)/.25);
}

// The SVG fallback has no sampled texture. Trace visible edges and preserve
// the same centers, timing and projection as the shared optical shader.
export function entranceOutline(effect: OrbEntrance, t: number, radius: number, axis: WakePoint): string {
  const center=radius*1.6, ms=t*effect.duration;
  const point=(x:number,y:number) => `${center+x*radius},${center+y*radius}`;
  const ellipse=(rx:number,ry:number,tilt=0,x=0,y=0,arc=Math.PI*2,start=0) => {
    const pts=[];
    const count=Math.max(2,Math.ceil(96*arc/(2*Math.PI)));
    for (let i=0;i<=count;i++) {
      const a=start+arc*i/count, dx=rx*Math.cos(a), dy=ry*Math.sin(a);
      pts.push(point(x+dx*Math.cos(tilt)-dy*Math.sin(tilt),y+dx*Math.sin(tilt)+dy*Math.cos(tilt)));
    }
    return 'M'+pts.join(' L');
  };
  switch (effect.id) {
    case 'bead': {
      const flat=1+.44*(1-smooth(ms/180));
      return ellipse(flat,1/flat);
    }
    case 'join': {
      const gather=smooth(ms/272), x=axis.x*(1-gather), y=axis.y*(1-gather);
      const r=.17+.85*gather-.02*smooth((ms-272)/48);
      const half=Math.acos(-Math.min(1,Math.hypot(x,y)/r));
      const angle=Math.atan2(y,x);
      return ellipse(r,r,0,x,y,2*half,angle-half)+ellipse(r,r,0,-x,-y,2*half,angle+Math.PI-half);
    }
    case 'reveal': {
      const half=Math.acos(Math.max(-1,Math.min(1,1-2.5*smooth(t))));
      return ellipse(1,1,0,0,0,2*half,Math.atan2(-.54,-.84)-half);
    }
    case 'dent': {
      const rise=smooth((ms-92)/189), r=.75+.268*rise-.018*smooth((ms-282)/53);
      return ellipse(r,r);
    }
    case 'turn': {
      const angle=.036+(Math.PI/2-.036)*smooth(t);
      return ellipse(Math.sin(angle),1,-.22*Math.cos(angle));
    }
    case 'drop': {
      const r=.13+.89*smooth(ms/269)-.02*smooth((ms-270)/70);
      const lift=1.04*smooth(ms/123)*(1-smooth((ms-123)/205));
      const pts=[];
      for(let i=0;i<128;i++){
        const a=i*Math.PI/64, x=Math.cos(a), y=Math.sin(a);
        const back=Math.max(0,-.64*x+.7684*y);
        const extent=r+Math.max(0,lift-r)*back*back*Math.exp(-3.4*Math.abs(.7684*x+.64*y));
        pts.push(point(.64*lift+x*extent,-.7684*lift+y*extent));
      }
      return 'M'+pts.join(' L')+'Z';
    }
    case 'corners': {
      const unfold=smooth((ms-40)/205), r=.63+.37*smooth(ms/242);
      const corner=r*(.16+.84*unfold*unfold), end=(r-corner)*.6*(1-unfold);
      let path='';
      for(const x of [-1,1]) for(const y of [-1,1]) {
        path+='M'+point(x*end,y*r)+' L'+point(x*(r-corner),y*r);
        for(let i=0;i<=16;i++){
          const a=Math.PI*i/32;
          path+=' L'+point(x*(r-corner+corner*Math.sin(a)),y*(r-corner+corner*Math.cos(a)));
        }
        path+=' L'+point(x*r,y*end);
      }
      return path;
    }
  }
}
