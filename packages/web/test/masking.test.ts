/**
 * Web 截图遮挡回归测试（实施计划 2.1 / 2.3 验收点）。
 *
 * 像素级断言：最终 PNG 字节解码后，敏感区域必须是不透明覆盖色（含外扩一圈），
 * 非敏感装饰节点颜色不得被误覆盖。假渲染器以"泄漏模式"无视克隆内 visibility
 * 直接绘制敏感内容（最坏情况），因此断言的是位图级最终保护本身，
 * 而非"遮挡函数是否被调用"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  captureViewport,
  countVisibleSensitiveRegions,
  computeCaptureScale,
  maskRectToOutputPixels,
  recordAndApplyCloneMask,
  validateProviderResult,
  verifyCanvasMaskCoverage,
  CaptureError,
  MAX_PNG_BYTES,
  type CaptureProviderResult,
} from '../src/capture';
import {
  COVER,
  DECOY,
  LEAK,
  VP400x300,
  FakeCanvas,
  addNode,
  blobToPng,
  createState,
  createFakeRenderer,
  installGeometryPatch,
  isCoverPixel,
  pixelColor,
  setDocumentScroll,
  stubCreateElementCanvas,
  type FakeRenderState,
  type PngImage,
} from './pixel-fixture';

let teardownGeometry: (() => void) | null = null;
let state: FakeRenderState;

beforeEach(() => {
  state = createState();
  teardownGeometry = installGeometryPatch();
  stubCreateElementCanvas(state);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => `blob:mock-${(b as Blob).size ?? 0}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  teardownGeometry?.();
  teardownGeometry = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function runBuiltin(expectedSensitiveCount: number, vp = VP400x300) {
  const result = await captureViewport({
    viewport: vp,
    expectedSensitiveCount,
    html2canvas: createFakeRenderer(state),
  });
  const png = await blobToPng(result.blob);
  return { result, png };
}

describe('像素级遮挡场景', () => {
  it('密码输入框：敏感区被不透明覆盖，外扩一圈，周围布局不误伤', async () => {
    addNode('<div></div>', '280,200,60,40', { color: [DECOY.r, DECOY.g, DECOY.b, 255] });
    const input = addNode('<input type="password" value="hunter2">', '100,100,120,24') as HTMLInputElement;

    const { result, png } = await runBuiltin(1);

    // 记录区 (100,100,120,24) → 外扩：x 99..220, y 99..124
    expect(result.maskedRegions).toEqual([{ x: 99, y: 99, width: 122, height: 26 }]);
    expect(isCoverPixel(png, 99, 99)).toBe(true); // 外扩一圈也必须覆盖
    expect(isCoverPixel(png, 219, 124)).toBe(true);
    expect(isCoverPixel(png, 150, 110)).toBe(true); // 区域中心
    expect(pixelColor(png, 98, 122)).not.toEqual([COVER.r, COVER.g, COVER.b, 255]); // 仅外扩 1px
    expect(pixelColor(png, 300, 220)).toEqual([DECOY.r, DECOY.g, DECOY.b, 255]); // 装饰节点未被误伤
    // 克隆隐藏后不再残留红色泄漏像素
    for (let x = 100; x < 220; x += 7) {
      expect(isCoverPixel(png, x, 112)).toBe(true);
    }
    // 克隆修改语义：值清除、可见性隐藏（important）、节点不被替换
    expect(input.value).toBe('');
    expect(input.style.getPropertyValue('visibility')).toBe('hidden');
    expect(input.style.getPropertyPriority('visibility')).toBe('important');
    expect(input.style.display).toBe(''); // 不改布局类型
    expect(input.parentNode).toBe(document.body);
  });

  it('敏感 <img>：src/srcset 清除且像素覆盖', async () => {
    const img = addNode('<img src="secret.png" srcset="secret-2x.png 2x" data-feedback-capture-mask>', '20,40,80,60');
    const { png } = await runBuiltin(1);
    expect(img.getAttribute('src')).toBe(null);
    expect(img.getAttribute('srcset')).toBe(null);
    expect(isCoverPixel(png, 60, 70)).toBe(true);
    expect(isCoverPixel(png, 19, 39)).toBe(true); // 外扩一圈
  });

  it('背景图元素：background-image 清除且像素覆盖', async () => {
    const div = addNode('<div data-feedback-capture-mask style="background-image:url(bg-secret.png)"></div>', '50,50,90,50');
    const { png } = await runBuiltin(1);
    expect(div.style.backgroundImage).toBe('none');
    expect(isCoverPixel(png, 95, 75)).toBe(true);
  });

  it('伪元素：注入样式含 ::before/::after 规则，区域仍被位图覆盖', async () => {
    addNode('<div data-feedback-capture-mask></div>', '30,30,70,70');
    const { png } = await runBuiltin(1);
    const style = document.head.querySelector('[data-feedback-capture-mask-style]');
    expect(style).not.toBeNull();
    expect(style!.textContent).toMatch(/\[data-feedback-capture-mask\]::before/);
    expect(style!.textContent).toMatch(/\[data-feedback-capture-mask\]::after/);
    expect(style!.textContent).toMatch(/input\[type="password"\]::before/);
    expect(isCoverPixel(png, 65, 65)).toBe(true);
  });

  it('SVG <image> 来源清除，敏感 svg 区域像素覆盖', async () => {
    const svgHost = addNode('<div data-feedback-capture-mask></div>', '200,20,100,100');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('data-fake-rect', '210,30,80,80');
    const image = document.createElementNS(svgNS, 'image');
    image.setAttribute('href', 'secret-token.svg');
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', 'secret-token.svg');
    image.setAttribute('data-fake-rect', '210,30,80,80');
    svg.appendChild(image);
    svgHost.appendChild(svg);

    const { png } = await runBuiltin(1);
    expect(image.getAttribute('href')).toBe(null);
    expect(image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe(null);
    expect(isCoverPixel(png, 250, 70)).toBe(true);
    expect(isCoverPixel(png, 199, 19)).toBe(true); // 外扩一圈
  });

  it('嵌套遮挡：子节点溢出父盒时并集覆盖', async () => {
    const outer = addNode('<div data-feedback-capture-mask></div>', '50,50,100,80');
    addNode('<input type="password" value="pw">', '120,110,60,40', { parent: outer });
    addNode('<div></div>', '250,250,50,30', { color: [DECOY.r, DECOY.g, DECOY.b, 255] });

    const { result, png } = await runBuiltin(2); // 外层 + 内层密码框均为敏感节点
    expect(result.maskedRegions.length).toBe(2);
    // 外层子树并集：x 50..180, y 50..150（含溢出的密码框）
    expect(result.maskedRegions[0]).toEqual({ x: 49, y: 49, width: 132, height: 102 });
    expect(isCoverPixel(png, 150, 145)).toBe(true); // 子节点溢出区被并集覆盖
    expect(isCoverPixel(png, 170, 130)).toBe(true);
    expect(pixelColor(png, 275, 265)).toEqual([DECOY.r, DECOY.g, DECOY.b, 255]); // 无关节点不受影响
  });

  it('旋转/缩放变换：AABB 坐标小数时向外取整 + 外扩 1px', async () => {
    // getClientRects 返回变换后边界（浏览器真实行为），此处给小数坐标
    addNode('<div data-feedback-capture-mask></div>', '10.2,20.7,33.1,11.9');
    const { result, png } = await runBuiltin(1);
    // x0=floor(10.2)-1=9 x1=ceil(43.3)+1=45 y0=floor(20.7)-1=19 y1=ceil(32.6)+1=34
    expect(result.maskedRegions).toEqual([{ x: 9, y: 19, width: 36, height: 15 }]);
    expect(isCoverPixel(png, 9, 19)).toBe(true);
    expect(isCoverPixel(png, 44, 33)).toBe(true);
    expect(isCoverPixel(png, 25, 25)).toBe(true);
    expect(pixelColor(png, 8, 19)).not.toEqual([COVER.r, COVER.g, COVER.b, 255]); // 只外扩 1px
    expect(pixelColor(png, 45, 33)).not.toEqual([COVER.r, COVER.g, COVER.b, 255]);
  });

  it('视口外敏感节点忽略；隐藏节点忽略（不生成遮挡）', async () => {
    addNode('<input type="password" data-fake-rect="500,10,20,20">', '500,10,20,20'); // x>400 视口外
    addNode('<div data-feedback-capture-mask data-fb-vis="hidden"></div>', '10,10,50,50');
    const { result } = await runBuiltin(0);
    // 两者都不产生遮挡矩形：视口外明确可忽略；隐藏节点未渲染（真实页面本无泄漏内容）
    expect(result.maskedRegions).toEqual([]);
    const png = await blobToPng(result.blob);
    // 隐藏节点未被误遮挡（无矩形覆盖）——红色仅存在于假渲染器的模拟泄漏，
    // 真实浏览器中 display/visibility 隐藏节点本就无像素。
    expect(pixelColor(png, 10, 10)).toEqual([LEAK.r, LEAK.g, LEAK.b, 255]);
    // 视口外节点：画布上根本没有它的像素
    expect(pixelColor(png, 399, 15)).toEqual([255, 255, 255, 255]);
  });
});

/**
 * T1 回归：真实渲染器（html2canvas-pro CanvasRenderer）在返回画布时会把
 * `scale(scale)·translate(-x,-y)` 变换留在 2D 上下文上。遮挡矩形必须以
 * 输出像素坐标绘制——不受残余变换影响；本组断言最终 PNG 像素。
 */
describe('渲染器残余变换与 DPR 缩放（T1 回归）', () => {
  /** 断言遮挡矩形覆盖完整（网格 + 右缘 + 底缘）。 */
  function assertCoveredRect(png: PngImage, r: { x: number; y: number; width: number; height: number }) {
    const stepX = Math.max(1, Math.floor(r.width / 8));
    const stepY = Math.max(1, Math.floor(r.height / 8));
    for (let y = r.y; y < r.y + r.height; y += stepY) {
      for (let x = r.x; x < r.x + r.width; x += stepX) {
        expect(isCoverPixel(png, x, y), `(${x},${y}) 应被覆盖`).toBe(true);
      }
      expect(isCoverPixel(png, r.x + r.width - 1, y), `右缘 (${r.x + r.width - 1},${y})`).toBe(true);
    }
    expect(isCoverPixel(png, r.x, r.y + r.height - 1), '底缘左').toBe(true);
    expect(isCoverPixel(png, r.x + r.width - 1, r.y + r.height - 1), '右下角').toBe(true);
  }

  /** 全图扫描敏感泄漏像素（红色），一个都不允许残留。 */
  function leakPixels(png: PngImage): Array<readonly [number, number]> {
    const out: Array<readonly [number, number]> = [];
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const c = pixelColor(png, x, y);
        if (c[0] === LEAK.r && c[1] === LEAK.g && c[2] === LEAK.b) out.push([x, y] as const);
      }
    }
    return out;
  }

  it('夹具契约：假渲染器在画布上下文留下 scale·translate 残余变换', async () => {
    const render = createFakeRenderer(state);
    const canvas = (await render(document.body, {
      width: 400,
      height: 300,
      scale: 1.5,
      x: 30,
      y: 50,
      onclone: () => {},
    })) as unknown as FakeCanvas;
    const tx = canvas.ctx.getTransform();
    // scale(1.5)·translate(-30,-50)：e = 1.5·(-30) = -45，f = 1.5·(-50) = -75
    expect(tx).toEqual({ a: 1.5, b: 0, c: 0, d: 1.5, e: -45, f: -75 });
  });

  it('scale=1 无滚动：残余变换为恒等（基线，不应回归）', async () => {
    addNode('<input type="password" value="hunter2">', '100,100,120,24');
    const { result, png } = await runBuiltin(1);
    expect(result.maskedRegions).toEqual([{ x: 99, y: 99, width: 122, height: 26 }]);
    assertCoveredRect(png, result.maskedRegions[0]!);
    expect(leakPixels(png)).toEqual([]);
  });

  it('scale=2（DPR 2）：遮挡按输出像素绘制，无泄漏、无误伤', async () => {
    addNode('<div></div>', '280,200,60,40', { color: [DECOY.r, DECOY.g, DECOY.b, 255] });
    addNode('<input type="password" value="hunter2">', '100,100,120,24');

    const { result, png } = await runBuiltin(1, { ...VP400x300, dpr: 2 });
    // 400x300 @2x → 800x600；ratio 2 → (100,100,120,24) → x 199..440, y 199..250
    expect(result.outputWidth).toBe(800);
    expect(result.outputHeight).toBe(600);
    expect(result.maskedRegions).toEqual([{ x: 199, y: 199, width: 242, height: 50 }]);
    assertCoveredRect(png, result.maskedRegions[0]!);
    expect(pixelColor(png, 198, 199)).not.toEqual([COVER.r, COVER.g, COVER.b, 255]); // 仅外扩 1 输出像素
    expect(pixelColor(png, 600, 440)).toEqual([DECOY.r, DECOY.g, DECOY.b, 255]); // 装饰节点未误伤
    expect(leakPixels(png)).toEqual([]);
  });

  it('scale=1.5（非整数）：遮挡按输出像素绘制', async () => {
    addNode('<div></div>', '280,200,60,40', { color: [DECOY.r, DECOY.g, DECOY.b, 255] });
    addNode('<input type="password" value="hunter2">', '100,100,120,24');

    const { result, png } = await runBuiltin(1, { ...VP400x300, dpr: 1.5 });
    // 400x300 @1.5 → 600x450；x0=floor(150)-1=149，x1=ceil(330)+1=331 → w=182；
    // y0=149，y1=ceil(186)+1=187 → h=38
    expect(result.outputWidth).toBe(600);
    expect(result.maskedRegions).toEqual([{ x: 149, y: 149, width: 182, height: 38 }]);
    assertCoveredRect(png, result.maskedRegions[0]!);
    expect(pixelColor(png, 460, 330)).toEqual([DECOY.r, DECOY.g, DECOY.b, 255]);
    expect(leakPixels(png)).toEqual([]);
  });

  it('scale<1（DPR 1 下大视口缩小到 2048 上限）：边缘敏感区完整覆盖', async () => {
    addNode('<div></div>', '100,100,50,50', { color: [DECOY.r, DECOY.g, DECOY.b, 255] });
    addNode('<input type="password" value="hunter2">', '2500,1360,60,40');

    const { result, png } = await runBuiltin(1, { width: 2560, height: 1440, scrollX: 0, scrollY: 0, dpr: 1 });
    // scale = 2048/2560 = 0.8 → 2048x1152；x0=floor(2000)-1=1999，x1=min(2048,2049)=2048 → w=49；
    // y0=1087，y1=min(1152,1121)=1121 → h=34
    expect(result.outputWidth).toBe(2048);
    expect(result.outputHeight).toBe(1152);
    expect(result.maskedRegions).toEqual([{ x: 1999, y: 1087, width: 49, height: 34 }]);
    assertCoveredRect(png, result.maskedRegions[0]!);
    expect(pixelColor(png, 90, 90)).toEqual([DECOY.r, DECOY.g, DECOY.b, 255]);
    expect(leakPixels(png)).toEqual([]);
  });

  it('滚动视口（scrollY=200, DPR 2）：残余平移不得二次作用', async () => {
    setDocumentScroll(0, 200);
    addNode('<div></div>', '280,420,60,40', { color: [DECOY.r, DECOY.g, DECOY.b, 255] });
    addNode('<input type="password" value="hunter2">', '100,320,120,24'); // 文档坐标 → 视口 y=120

    const { result, png } = await runBuiltin(1, { width: 400, height: 300, scrollX: 0, scrollY: 200, dpr: 2 });
    // ratio 2：x 199..440，y0=floor(240)-1=239，y1=ceil(288)+1=289 → h=50
    expect(result.maskedRegions).toEqual([{ x: 199, y: 239, width: 242, height: 50 }]);
    assertCoveredRect(png, result.maskedRegions[0]!);
    expect(pixelColor(png, 600, 470)).toEqual([DECOY.r, DECOY.g, DECOY.b, 255]);
    expect(leakPixels(png)).toEqual([]);
  });

  it('无敏感区 + 残余变换：正常产出 PNG，内容不被误遮', async () => {
    addNode('<div></div>', '280,200,60,40', { color: [DECOY.r, DECOY.g, DECOY.b, 255] });
    const { result, png } = await runBuiltin(0, { ...VP400x300, dpr: 2 });
    expect(result.maskedRegions).toEqual([]);
    expect(pixelColor(png, 600, 440)).toEqual([DECOY.r, DECOY.g, DECOY.b, 255]);
  });

  it('缩小重编码与首轮共用修复：DPR 2 下重编码后遮挡仍与最终 PNG 一致', async () => {
    state.blobSizes = [MAX_PNG_BYTES + 1]; // 第 2 次（重编码后）返回真实小 PNG
    addNode('<input type="password" value="hunter2">', '100,100,120,24');

    const { result, png } = await runBuiltin(1, { ...VP400x300, dpr: 2 });
    expect(state.toBlobCalls).toBe(2);
    // 800x600 → ×0.8 → 640x480；ratio 1.6 → x 159..352，y 159..199
    expect(result.outputWidth).toBe(640);
    expect(result.outputHeight).toBe(480);
    expect(result.maskedRegions).toEqual([{ x: 159, y: 159, width: 194, height: 41 }]);
    assertCoveredRect(png, result.maskedRegions[0]!);
    expect(leakPixels(png)).toEqual([]);
  });
});

describe('遮挡失败规则（不允许静默跳过）', () => {
  it('克隆定位数 < 真实文档可见敏感数 → locate-failed，且不编码', async () => {
    addNode('<input type="password">', '10,10,20,20');
    await expect(runBuiltin(3)).rejects.toThrow(/定位到/);
    expect(state.toBlobCalls).toBe(0); // 失败发生在编码之前
  });

  it('敏感节点坐标非有限 → locate-failed，不静默', async () => {
    addNode('<input type="password">', 'nan,10,20,20');
    let err: unknown;
    try {
      await runBuiltin(1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).reason).toBe('locate-failed');
    expect(state.toBlobCalls).toBe(0);
  });

  it('位图填充失效 → verify-failed，且未编码 PNG', async () => {
    state.paint = false; // 模拟遮挡矩形未被填充
    addNode('<input type="password">', '100,100,120,24');
    let err: unknown;
    try {
      await runBuiltin(1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).reason).toBe('verify-failed');
    expect(state.toBlobCalls).toBe(0); // 遮挡完成（验证通过）之前绝不编码
  });

  it('位图不可读（污染）→ verify-failed，不静默跳过', async () => {
    state.tainted = true;
    addNode('<input type="password">', '100,100,120,24');
    let err: unknown;
    try {
      await runBuiltin(1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).reason).toBe('verify-failed');
  });
});

describe('缩小重编码（2.3 编码超限策略）', () => {
  const big = MAX_PNG_BYTES + 1;

  it('前 3 次超限：每轮按实际输出尺寸重填遮挡并重新验证，第 4 次通过', async () => {
    state.blobSizes = [big, big, big]; // 第 4 次返回真实（小）PNG
    addNode('<input type="password">', '100,100,120,24');
    const { result, png } = await runBuiltin(1);
    expect(state.toBlobCalls).toBe(4);
    // 400x300 → ×0.8×0.8×0.8 → 204x153
    expect(result.outputWidth).toBe(204);
    expect(result.outputHeight).toBe(153);
    expect(png.width).toBe(204);
    // 遮挡映射到新尺寸：ratio 0.51 → x0=floor(51)-1=50
    expect(result.maskedRegions).toEqual([{ x: 50, y: 50, width: 64, height: 15 }]);
    expect(isCoverPixel(png, 50, 50)).toBe(true);
    expect(isCoverPixel(png, 113, 64)).toBe(true);
  });

  it('三次重编码仍超限 → 整次截图失败（不返回超大图）', async () => {
    state.blobSizes = [big, big, big, big];
    addNode('<input type="password">', '100,100,120,24');
    let err: unknown;
    try {
      await runBuiltin(1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CaptureError);
    expect((err as CaptureError).reason).toBe('size-limit');
    expect(state.toBlobCalls).toBe(4); // 初始 + 3 次重试，到此为止
  });
});

describe('遮挡几何与限制纯函数', () => {
  it('computeCaptureScale：min(dpr, 2, 2048/最长边, sqrt(4M/面积))', () => {
    expect(computeCaptureScale({ width: 1000, height: 800 }, 3)).toBeCloseTo(2);
    expect(computeCaptureScale({ width: 3000, height: 1000 }, 2)).toBeCloseTo(2048 / 3000);
    expect(computeCaptureScale({ width: 4000, height: 4000 }, 2)).toBeCloseTo(0.5);
    expect(computeCaptureScale({ width: 400, height: 300 }, 1)).toBe(1);
  });

  it('maskRectToOutputPixels：向外取整 + 外扩 1px + 裁到画布', () => {
    expect(maskRectToOutputPixels({ x: 10.5, y: 20.5, width: 30, height: 40 }, 2, 2, 500, 500)).toEqual({
      x: 20,
      y: 40,
      width: 62,
      height: 82,
    });
    const edge = maskRectToOutputPixels({ x: 249, y: 249, width: 1, height: 1 }, 1, 1, 250, 250);
    expect(edge.x + edge.width).toBe(250);
    expect(edge.y + edge.height).toBe(250);
    expect(() => maskRectToOutputPixels({ x: NaN, y: 0, width: 1, height: 1 }, 1, 1, 10, 10)).toThrow(CaptureError);
    expect(() => maskRectToOutputPixels({ x: 0, y: 0, width: 1, height: 1 }, Infinity, 1, 10, 10)).toThrow(CaptureError);
  });

  it('verifyCanvasMaskCoverage：覆盖不足必须抛错（漏一列即失败）', () => {
    const fake = new FakeCanvas(createState());
    fake.width = 10;
    fake.height = 10;
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(() => verifyCanvasMaskCoverage(fake as unknown as HTMLCanvasElement, [rect])).toThrow(/未被不透明覆盖/);
    fake.fillRectPixels(0, 0, 9, 10, [COVER.r, COVER.g, COVER.b, 255]); // 缺最后一列
    expect(() => verifyCanvasMaskCoverage(fake as unknown as HTMLCanvasElement, [rect])).toThrow(/未被不透明覆盖/);
    fake.fillRectPixels(9, 0, 1, 10, [COVER.r, COVER.g, COVER.b, 255]);
    expect(() => verifyCanvasMaskCoverage(fake as unknown as HTMLCanvasElement, [rect])).not.toThrow();
  });
});

describe('captureProvider 契约校验（组件统一校验）', () => {
  const png = new Blob(['x'], { type: 'image/png' });

  it('旧回调兼容：无敏感区域时只返回 {blob,width,height} 可用', () => {
    const legacy: CaptureProviderResult = { blob: png, width: 1200, height: 900 };
    const v = validateProviderResult(legacy, 0);
    expect(v.viewportWidth).toBe(1200);
    expect(v.outputHeight).toBe(900);
    expect(v.maskedRegions).toEqual([]);
  });

  it('存在可见敏感区域：无同帧证明 / 遮挡列表非法一律拒绝', () => {
    const legacy: CaptureProviderResult = { blob: png, width: 1200, height: 900 };
    expect(() => validateProviderResult(legacy, 2)).toThrow(/同帧|敏感/);
    expect(() =>
      validateProviderResult({ ...legacy, sameFrameMasking: true }, 2),
    ).toThrow(CaptureError);
    expect(() =>
      validateProviderResult({ ...legacy, sameFrameMasking: true, maskedRegions: [] }, 2),
    ).toThrow(/未遮挡/);
    expect(() =>
      validateProviderResult(
        { ...legacy, sameFrameMasking: true, maskedRegions: [{ x: 1150, y: 0, width: 100, height: 20 }] },
        2,
      ),
    ).toThrow(/超出/);
    expect(() =>
      validateProviderResult(
        { ...legacy, sameFrameMasking: true, maskedRegions: [{ x: 10, y: 10, width: Infinity, height: 5 }] },
        2,
      ),
    ).toThrow(/非有限/);
    expect(
      validateProviderResult(
        { ...legacy, sameFrameMasking: true, maskedRegions: [{ x: 10, y: 10, width: 100, height: 20 }] },
        2,
      ).maskedRegions.length,
    ).toBe(1);
  });

  it('PNG / 尺寸 / 文件大小统一校验', () => {
    expect(() =>
      validateProviderResult({ blob: new Blob(['x'], { type: 'image/jpeg' }), width: 10, height: 10 }, 0),
    ).toThrow(/PNG/);
    expect(() => validateProviderResult({ blob: png, width: 5000, height: 10 }, 0)).toThrow(/2048/);
    expect(() => validateProviderResult({ blob: png, width: 2048, height: 2048 }, 0)).toThrow(/像素/);
    expect(() => validateProviderResult({ blob: png, width: 0, height: 10 }, 0)).toThrow(/正/);
    expect(() => validateProviderResult({ blob: png, width: NaN, height: 10 }, 0)).toThrow(/有限/);
    const bigBlob = new Blob(['x'], { type: 'image/png' });
    Object.defineProperty(bigBlob, 'size', { value: MAX_PNG_BYTES + 1 });
    expect(() => validateProviderResult({ blob: bigBlob, width: 10, height: 10 }, 0)).toThrow(/大小/);
  });

  it('providers 可上报逻辑视口（viewport 字段），缺省回落图像尺寸', () => {
    const v = validateProviderResult(
      { blob: png, width: 800, height: 600, viewport: { width: 1600, height: 1200 } },
      0,
    );
    expect(v.viewportWidth).toBe(1600);
    expect(v.outputWidth).toBe(800);
  });
});

describe('真实文档敏感区域计数', () => {
  it('统计可见敏感节点，穿透 shadow root，忽略隐藏/视口外/组件自身', () => {
    addNode('<input type="password">', '10,10,20,20');
    addNode('<div data-feedback-capture-mask></div>', '40,40,20,20');
    addNode('<input type="password" data-fb-vis="hidden">', '70,70,20,20');
    addNode('<input type="password">', '2000,10,20,20'); // 远出错出 window 视口（happy-dom 1024x768）
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    document.body.appendChild(host);
    const inner = document.createElement('input');
    inner.type = 'password';
    inner.setAttribute('data-fake-rect', '150,150,20,20');
    shadow.appendChild(inner);

    expect(countVisibleSensitiveRegions(document)).toBe(3);
    expect(countVisibleSensitiveRegions(document, { ignore: () => true })).toBe(0);
  });
});

describe('克隆级遮挡语义', () => {
  it('仅修改克隆可见性/来源，不替换节点、不改布局；计数不足抛错', () => {
    const img = addNode('<img src="a.png" srcset="b.png 2x" data-feedback-capture-mask>', '5,5,40,40');
    const parentBefore = img.parentNode;
    const rects = recordAndApplyCloneMask(document, { width: 400, height: 300 }, 1);
    expect(rects).toEqual([{ x: 5, y: 5, width: 40, height: 40 }]);
    expect(img.parentNode).toBe(parentBefore); // 原节点保留
    expect(img.tagName).toBe('IMG'); // 未被 div 替换
    expect(img.style.width).toBe(''); // 未布局尺寸
    expect(img.getAttribute('src')).toBe(null);
    expect(() => recordAndApplyCloneMask(document, { width: 400, height: 300 }, 99)).toThrow(/无法保证遮挡/);
  });
});
