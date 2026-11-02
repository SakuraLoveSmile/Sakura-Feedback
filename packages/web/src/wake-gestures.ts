/** Internal document touch adapter. It emits no public events and captures no pixels. */
export const WAKE_GESTURES = [
  { id: 'two-finger-hold', title: '双指长按', description: '两指同时按住 700 毫秒' },
  { id: 'three-finger-swipe-up', title: '三指上滑', description: '三指同时向上滑动' },
  { id: 'two-finger-double-tap', title: '双指双击', description: '用两指连续轻点两次' },
] as const;
export type WakeGestureId = typeof WAKE_GESTURES[number]['id'];
type Point = { x: number; y: number };
type Finger = { start: Point; last: Point };
type Round = { start: number; fingers: Map<number, Finger>; fullAt: number; firstUp: number | null; latched: boolean };
const distance = (a: Point, b: Point) => Math.hypot(a.x-b.x, a.y-b.y);
const center = (fingers: Map<number, Finger>, start = false): Point => {
  const points = [...fingers.values()].map(f => start ? f.start : f.last);
  return { x: points.reduce((sum,p) => sum+p.x,0)/points.length, y: points.reduce((sum,p) => sum+p.y,0)/points.length };
};
export function wakePreferenceKey(appId: string): string { return `feedback:wake-gestures:v1:${encodeURIComponent(appId)}`; }
export function parseWakePreference(value: string | null): WakeGestureId[] {
  try {
    const data: unknown = JSON.parse(value ?? 'null');
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('enabled' in data) || !Array.isArray(data.enabled)) return [];
    const enabled = data.enabled;
    return WAKE_GESTURES.map(g => g.id).filter(id => enabled.includes(id));
  } catch { return []; }
}

export class WakeGestures {
  private round: Round | null = null;
  private previousTap: { time: number; point: Point } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private contacts = 0;
  private blocked = false;
  private reserved = false;
  private suppress: { until: number; point: Point } | null = null;
  private attached = false;

  constructor(private readonly options: {
    enabled: () => readonly WakeGestureId[];
    allowed: () => boolean;
    excluded: (event: TouchEvent) => boolean;
    hint: (visible: boolean) => void;
    trigger: (point: Point) => void;
  }) {}

  connect(): void {
    if (this.attached) return;
    this.attached = true;
    for (const type of ['touchstart','touchmove','touchend','touchcancel']) document.addEventListener(type,this.touch,{capture:true,passive:false});
    document.addEventListener('click',this.click,true);
    window.addEventListener('scroll',this.scroll,true);
  }
  disconnect(): void {
    this.reset(); this.contacts = 0; this.blocked = false; this.suppress = null;
    if (!this.attached) return;
    this.attached = false;
    for (const type of ['touchstart','touchmove','touchend','touchcancel']) document.removeEventListener(type,this.touch,true);
    document.removeEventListener('click',this.click,true);
    window.removeEventListener('scroll',this.scroll,true);
  }
  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null; this.round = null; this.previousTap = null; this.reserved = false;
    this.blocked = this.contacts > 0;
    this.options.hint(false);
  }
  private scroll = (): void => { this.reset(); };
  private click = (event: MouseEvent): void => {
    const touch = (event as PointerEvent).pointerType === 'touch' || (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }).sourceCapabilities?.firesTouchEvents;
    if (!touch || !this.suppress || performance.now() > this.suppress.until || distance({x:event.clientX,y:event.clientY},this.suppress.point)>32) return;
    this.suppress = null; event.preventDefault(); event.stopImmediatePropagation();
  };
  private schedule(delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.options.allowed()) { this.reset(); return; }
      const r = this.round;
      if (!r) { this.previousTap = null; return; }
      if (r.fingers.size === 2 && r.firstUp === null && this.has('two-finger-hold') && performance.now()-r.fullAt >= 700) this.latch();
      else this.reset();
    }, Math.max(0,delay));
  }
  private has(id: WakeGestureId): boolean { return this.options.enabled().includes(id); }
  private latch(): void {
    if (!this.round) return;
    this.round.latched = true; this.previousTap = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.options.hint(true);
  }
  private finish(point: Point, now: number): void {
    this.suppress={point,until:now+800};
    this.reset(); this.blocked=false;
    this.options.trigger(point);
  }
  private touch = (base: Event): void => {
    const event = base as TouchEvent, now = performance.now();
    this.contacts = event.touches.length;
    if (event.type === 'touchcancel' || !this.options.allowed() || !this.options.enabled().length) { this.reset(); if (!this.contacts) this.blocked=false; return; }
    if (this.blocked) { if (!this.contacts) this.blocked=false; return; }
    if (event.type === 'touchstart') {
      if (this.options.excluded(event) || this.round?.latched || this.round !== null && this.round.firstUp !== null) { this.reset(); return; }
      if (!this.round) {
        if (this.previousTap && now-this.previousTap.time>300) this.previousTap=null;
        // A sequence must start with fresh contacts, never with fingers inherited from ignored UI.
        if (event.touches.length !== event.changedTouches.length) { this.reset(); return; }
        this.round = { start:now, fingers:new Map(), fullAt:now, firstUp:null, latched:false };
      }
      const r=this.round;
      for (const t of Array.from(event.changedTouches)) {
        const point={x:t.clientX,y:t.clientY};
        r.fingers.set(t.identifier,{start:point,last:point});
      }
      for (const t of Array.from(event.touches)) {
        const finger=r.fingers.get(t.identifier);
        if (finger) finger.last={x:t.clientX,y:t.clientY};
      }
      const count=r.fingers.size;
      if (count>3 || now-r.start>180 || count===3 && !this.has('three-finger-swipe-up')) { this.reset(); return; }
      if (count===2) {
        r.fullAt=now;
        if (this.has('two-finger-hold')) this.schedule(700);
        else if (this.has('two-finger-double-tap') && now-r.start<=120) this.schedule(221-(now-r.start));
        else if (this.has('three-finger-swipe-up')) this.schedule(181-(now-r.start));
        else this.reset();
      } else if (count===3) {
        if ([...r.fingers.values()].some(f=>distance(f.start,f.last)>12)) { this.reset(); return; }
        // Swipe displacement begins when the third finger joins, not at earlier downs.
        for (const finger of r.fingers.values()) finger.start={...finger.last};
        if (!event.cancelable) { this.reset(); return; }
        r.fullAt=now; this.reserved=true; this.previousTap=null; this.schedule(701);
      } else this.schedule(181);
    }
    const r=this.round;
    if (!r) return;
    for (const t of Array.from(event.changedTouches)) {
      const finger=r.fingers.get(t.identifier);
      if (!finger) { this.reset(); return; }
      finger.last={x:t.clientX,y:t.clientY};
    }
    if (!r.latched) {
      const fingers=[...r.fingers.values()], count=fingers.length;
      if (count<3 && (fingers.some(f=>distance(f.start,f.last)>12) || count===2 && Math.abs(distance(fingers[0]!.start,fingers[1]!.start)-distance(fingers[0]!.last,fingers[1]!.last))>12)) { this.reset(); return; }
      if (count===3) {
        const from=center(r.fingers,true), to=center(r.fingers), up=from.y-to.y, dx=Math.abs(to.x-from.x);
        if (now-r.fullAt>700 || up<0 || fingers.some(f=>Math.abs(f.last.x-f.start.x)>64) || dx>48) { this.reset(); return; }
        if (up>=72 && dx<=up*.6 && fingers.every(f=>f.start.y-f.last.y>=48)) this.latch();
      }
    }
    if (this.reserved || r.latched) {
      if (event.cancelable) event.preventDefault();
    }
    if (event.type !== 'touchend') return;
    if (r.latched) {
      if (this.contacts) return;
      const point=center(r.fingers);
      this.finish(point,now);
      return;
    }
    if (r.firstUp === null) r.firstUp=now;
    if (r.fingers.size!==2 || !this.has('two-finger-double-tap') || r.fullAt-r.start>120 || now-r.start>220 || now-r.firstUp>100) { this.reset(); return; }
    if (this.contacts) { this.schedule(Math.min(101-(now-r.firstUp),221-(now-r.start))); return; }
    const point=center(r.fingers), previous=this.previousTap;
    if (previous && distance(previous.point,point)<=32) {
      r.latched=true;
      if (event.cancelable) event.preventDefault();
      this.finish(point,now);
    } else {
      this.round=null; this.reserved=false; this.previousTap={time:now,point}; this.schedule(301);
    }
  };
}
