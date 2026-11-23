import { createWaterSurface } from './water-ripple';
import type { RegionViewport } from './region';
import type { WakePoint } from './wake-gestures';

function smooth(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function layer(parent: HTMLElement, name: string): HTMLDivElement {
  const child = document.createElement('div');
  child.className = name;
  parent.append(child);
  return child;
}

function mask(element: HTMLElement, radius: number, stops: string): void {
  element.style.setProperty('--fb-wave-mask',
    `radial-gradient(circle ${radius.toFixed(2)}px at var(--fb-wake-origin), ${stops})`);
}

const spectrum = 'conic-gradient(from 90deg at center, #3d370c 0deg, #40251b 45deg, #3e2040 90deg, #252848 135deg, #103744 175deg, #1a3248 215deg, #343744 268deg, #3e3424 310deg, #3d370c 360deg)';
const haloProfile = 'transparent 0%, #00000003 16%, #00000024 34%, #000000a3 52%, black 65%, #000000de 74%, #00000059 86%, #0000000f 95%, transparent 100%';

function aurora(
  parent: HTMLElement, shortSide: number, far: number, origins: readonly WakePoint[],
): (t: number) => void {
  const halo = layer(parent, 'fb-wake-spectrum');
  halo.style.backgroundImage = spectrum;
  const start = shortSide * .06;
  return t => {
    const radius = start + (far * 1.60 - start) * (1 - (1 - t) ** 1.5);
    const masks = origins.map(({ x, y }) =>
      `radial-gradient(circle ${radius.toFixed(2)}px at ${x}px ${y}px, ${haloProfile})`);
    const edge = .42 * smooth((t - .40) / .34);
    if (edge > 0) {
      masks.push(`radial-gradient(ellipse 70% 70% at center, transparent 54%, rgba(0,0,0,${(edge * .24).toFixed(3)}) 74%, rgba(0,0,0,${edge.toFixed(3)}) 100%)`);
    }
    // 同一层颜色穿过合并后的蒙版，两指波面相交时不会过曝。
    halo.style.setProperty('--fb-wave-mask', masks.join(', '));
    halo.style.opacity = (smooth(t / .13) * (1 - smooth((t - .68) / .32))).toFixed(3);
  };
}

function ripple(
  parent: HTMLElement, viewport: RegionViewport, frozenUrl: string, x: number, y: number,
): (t: number, radius: number) => void {
  const { width, height } = viewport;
  const unit = Math.min(Math.min(width, height) / 361, 1.6);
  const slopes = [layer(parent, 'fb-ripple-wave'), layer(parent, 'fb-ripple-wave')];
  for (const slope of slopes) slope.style.backgroundRepeat = 'no-repeat';
  return (t, radius) => {
    if (radius <= 0) return;
    const amplitude = smooth(t / .065) * (1 - smooth((t - .275) / .625));
    const halfWidth = Math.min(radius * .18, Math.max(3 * unit, Math.min(radius * .10, 25 * unit)));
    const dim = (.26 * Math.min(1, t * 2000 / 430)).toFixed(3);
    parent.style.setProperty('--fb-water-angle', (t * 120).toFixed(2) + 'deg');
    slopes.forEach((wave, i) => {
      const outerSlope = i === 0;
      const crest = radius + halfWidth * (outerSlope ? .63 : -.30);
      const scale = 1 + amplitude * halfWidth * (outerSlope ? -.25 : .44) / radius;
      const stop = (offset: number) => Math.max(0, crest + offset * halfWidth).toFixed(2) + 'px';
      const shade = `radial-gradient(circle at var(--fb-wake-origin), #25365400 ${stop(-1)}, #25365470 ${stop(-.40)}, #4f8bbb62 ${stop(-.16)}, #f5ecd088 ${stop(.06)}, #d8eaf445 ${stop(.31)}, #d8eaf400 ${stop(1)})`;
      // 同一波峰的内外两坡采样同一张已遮挡的冻结图，折射方向相反。
      wave.style.backgroundImage = `${shade}, linear-gradient(rgb(99 93 146 / ${dim}), rgb(99 93 146 / ${dim})), url("${frozenUrl}")`;
      wave.style.backgroundSize = `100% 100%, 100% 100%, ${width * scale}px ${height * scale}px`;
      wave.style.backgroundPosition = `0 0, 0 0, ${x * (1 - scale)}px ${y * (1 - scale)}px`;
      mask(wave, crest + halfWidth, `transparent ${stop(-1)}, #0000004d ${stop(-.63)}, black ${stop(-.24)}, black ${stop(0)}, #000000e0 ${stop(.33)}, #00000040 ${stop(.72)}, transparent ${stop(1)}`);
      wave.style.opacity = (amplitude * (outerSlope ? .66 : 1)).toFixed(3);
    });
  };
}

/** 水纹以中点传播，波光分别使用指尖。无双指位置时共用一个起点。 */
export function createWakePaint(
  visual: 'ripple' | 'aurora', parent: HTMLElement, { width, height }: RegionViewport, image: HTMLImageElement,
  { x, y }: WakePoint, fingertips: readonly WakePoint[],
) {
  parent.replaceChildren();
  parent.classList.toggle('is-aurora', visual === 'aurora');
  parent.style.setProperty('--fb-wake-origin', `${x}px ${y}px`);
  const shortSide = Math.min(width, height);
  if (visual === 'aurora') {
    const draw = aurora(parent, shortSide, Math.hypot(Math.max(x, width - x), Math.max(y, height - y)),
      fingertips.length ? fingertips : [{ x, y }]);
    return { draw };
  }

  // The displayed image is the same masked capture used by the selector.
  // Try uploading once it has decoded. CSS can paint while waiting or after context loss.
  const fallback = () => {
    parent.classList.add('is-water-fallback');
    return ripple(parent, { width, height }, image.src, x, y);
  };
  const far = Math.hypot(Math.max(x, width - x), Math.max(y, height - y));
  let drawFallback = fallback();
  let surface: ReturnType<typeof createWaterSurface> = null;
  let attempted = false;
  return {
    draw(t: number, dim: number) {
      const travel = Math.min(1, t / .9);
      const radius = far * (.38 * travel + .62 * smooth(travel));
      if (!attempted && image.complete && image.naturalWidth > 0) {
        attempted = true;
        surface = createWaterSurface(image, { width, height }, { x, y });
        if (surface) {
          parent.replaceChildren(surface.canvas);
          parent.classList.remove('is-water-fallback');
        }
      }
      if (surface) {
        if (surface.draw(t * 2, dim, radius)) return;
        surface.dispose();
        surface = null;
        drawFallback = fallback();
      }
      drawFallback(t, radius);
    },
    dispose() {
      surface?.dispose();
      parent.classList.remove('is-water-fallback');
    },
  };
}
