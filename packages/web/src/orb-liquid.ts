/** First-preview directional shape. All values are logical pixels. */
export interface LiquidShape { dirX: number; dirY: number; deform: number; wobble: number }
export interface LiquidSnapshot extends LiquidShape { x: number; y: number; radius: number }
export const smoothstep = (p: number): number => {
  const t = Math.max(0, Math.min(1, p));
  return t * t * (3 - 2 * t);
};
export const progress = (time: number, start: number, end: number): number => smoothstep((time - start) / (end - start));
const STEP = 1 / 240;

export class OrbLiquid implements LiquidShape {
  x = 0; y = 0; tx = 0; ty = 0; vx = 0; vy = 0;
  dirX = 1; dirY = 0; deform = 0; wobble = 0; radius = 52;
  private accumulator = 0;
  private moving = false;
  private released = -1;

  reset(x: number, y: number): void {
    this.x = this.tx = x; this.y = this.ty = y;
    this.vx = this.vy = this.accumulator = this.deform = this.wobble = 0;
    this.dirX = 1; this.dirY = 0; this.radius = 52;
    this.moving = false; this.released = -1;
  }

  advance(frameDt: number, moving: boolean, reduced = false): void {
    if (reduced) { this.reset(this.tx, this.ty); return; }
    if (moving) { this.released = -1; this.wobble = 0; }
    else if (this.moving) this.released = 0;
    this.moving = moving;
    this.accumulator += Math.max(0, Math.min(frameDt, .032));
    while (this.accumulator + 1e-12 >= STEP) {
      this.accumulator -= STEP;
      const stiffness = moving ? 290 : 240, damping = moving ? 24 : 19;
      this.vx += ((this.tx - this.x) * stiffness - this.vx * damping) * STEP;
      this.vy += ((this.ty - this.y) * stiffness - this.vy * damping) * STEP;
      this.x += this.vx * STEP; this.y += this.vy * STEP;
      const speed = Math.hypot(this.vx, this.vy);
      if (speed > 12) { this.dirX = this.vx / speed; this.dirY = this.vy / speed; }
      this.deform += (Math.min(speed / 530, 1.3) - this.deform) * Math.min(STEP * 12, 1);
      this.radius += ((moving ? 54 : 52) - this.radius) * Math.min(STEP * 12, 1);
      if (this.released >= 0) {
        this.released += STEP;
        this.wobble = Math.sin(this.released * 23) * Math.exp(-this.released * 6);
      }
    }
    if (!moving && this.settled) {
      this.x = this.tx; this.y = this.ty; this.vx = this.vy = this.deform = this.wobble = 0;
      this.radius = 52; this.released = -1;
    }
  }

  get settled(): boolean {
    return Math.hypot(this.tx - this.x, this.ty - this.y) < .02 && Math.hypot(this.vx, this.vy) < .1 &&
      this.deform < .0005 && (this.released < 0 || Math.exp(-this.released * 6) < .0005) && Math.abs(this.radius - 52) < .001;
  }
}

/** Radial boundary of the exact preview q-space contour; shared by the safe CPU outline. */
export function liquidBoundary(theta: number, shape: LiquidShape): number {
  const x = Math.cos(theta), y = Math.sin(theta), stretch = 1 + shape.deform * .72 * .20;
  const qx = (x * shape.dirX + y * shape.dirY) / stretch;
  const qy = (-x * shape.dirY + y * shape.dirX) * Math.sqrt(stretch);
  const a = Math.atan2(qy, qx);
  const contour = 1 + shape.deform * .72 * (.045 * Math.cos(3*a) - .035 * Math.cos(a)) + shape.wobble * .028 * Math.cos(2*a + .7);
  return contour / Math.hypot(qx, qy);
}

/** First-preview optical mapping: upright magnification with a continuously increasing source radius. */
export function lensSourceRadius(r: number): number {
  return r * (1 / 1.62 + .54 * Math.max(0, Math.min(1, r)) ** 7);
}
