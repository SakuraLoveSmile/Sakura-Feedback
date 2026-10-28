/**
 * T2 图片编辑器验收：调整选区 → 应用裁剪 → 保存图片。
 *
 * - 裁剪选区松手后**持续绘制**（边框 + 外部暗化 + 八个控制点），可移动 / 缩放 / 重新框选；
 * - 「裁剪结果」独立预览随选区同步更新，并显示输出尺寸；
 * - 存在未应用选区时「保存」禁用并说明原因（点击也不生效）；
 * - 「遮挡 → 裁剪 → 撤销 → 保存」像素级断言：遮挡完好、辅助元素绝不入图。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/index';
import { cleanup, mount, type Mounted } from './helpers';
import { COVER, blobToPng, canvasAsPixel, encodePng, createState, stubCreateElementCanvas } from './pixel-fixture';

const ORANGE: [number, number, number, number] = [200, 100, 50, 255];
const DIM: [number, number, number, number] = [0, 0, 0, 115]; // rgba(0,0,0,0.45) 外部暗化

function uniformPng(size: number, rgba: [number, number, number, number]): File {
  const px = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = rgba[0];
    px[i + 1] = rgba[1];
    px[i + 2] = rgba[2];
    px[i + 3] = rgba[3];
  }
  return new File([encodePng(size, size, px)], 'img.png', { type: 'image/png' });
}

function pointer(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
  );
}

async function settled(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

let savedUrls: Blob[];

async function readyEditor(m: Mounted, size = 32): Promise<HTMLCanvasElement> {
  const input = m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
  Object.defineProperty(input, 'files', { value: [uniformPng(size, ORANGE)], configurable: true });
  input.dispatchEvent(new Event('change'));
  await settled();
  m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!.click();
  await settled();
  const canvas = m.root.querySelector<HTMLCanvasElement>('.fb-editor-canvas')!;
  expect(canvas).not.toBeNull();
  return canvas;
}

function editor(m: Mounted): HTMLElement {
  return m.root.querySelector<HTMLElement>('.fb-editor')!;
}

function tools(m: Mounted): HTMLButtonElement[] {
  return Array.from(m.root.querySelectorAll<HTMLButtonElement>('.fb-editor-tool'));
}

function saveBtn(m: Mounted): HTMLButtonElement {
  return m.root.querySelector<HTMLButtonElement>('.fb-editor-actions .fb-editor-btn.is-primary')!;
}

beforeEach(() => {
  savedUrls = [];
  stubCreateElementCanvas(createState());
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const png = await blobToPng(blob);
    return {
      width: png.width,
      height: png.height,
      data: png.data,
      close: () => {},
      getContext: () => null,
    };
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    savedUrls.push(b as Blob);
    return `blob:mock-${savedUrls.length}-${(b as Blob).size}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(cleanup);

describe('T2 裁剪选区持续可见与结果预览', () => {
  it('松手后选区边框与外部暗化持续绘制，输出尺寸与预览同步更新', async () => {
    const m = mount();
    m.widget.open();
    const canvas = await readyEditor(m);
    expect(canvasAsPixel(canvas).width).toBe(32);

    // 裁剪工具 → 框选 (0,0)-(16,16)
    tools(m)[0]!.click();
    pointer(canvas, 'pointerdown', 0, 0);
    pointer(canvas, 'pointermove', 16, 16);
    pointer(canvas, 'pointerup', 16, 16);
    await settled(2);

    // 选区持续绘制：外部被暗化、内部保持原图
    const px = canvasAsPixel(canvas);
    expect(px.pixel(31, 31)).toEqual(DIM); // 选区外（右下）
    expect(px.pixel(0, 20)).toEqual(DIM); // 选区外（正下）
    expect(px.pixel(8, 8)).toEqual(ORANGE); // 选区内
    // 控制点存在（选区右下角控制点为白色）
    expect(px.pixel(16, 16)).toEqual([255, 255, 255, 255]);

    // 独立「裁剪结果」预览 + 输出尺寸
    const preview = m.root.querySelector<HTMLCanvasElement>('.fb-editor-preview')!;
    expect(preview).not.toBeNull();
    expect(canvasAsPixel(preview).width).toBe(16);
    expect(canvasAsPixel(preview).height).toBe(16);
    expect(m.root.querySelector('.fb-editor-result-size')?.textContent).toBe('输出尺寸：16×16 像素');
    // 预览与主画布是两个独立元素
    expect(preview).not.toBe(canvas);
    // 裁剪条可见
    expect(m.root.querySelector<HTMLElement>('.fb-editor-cropbar')!.hidden).toBe(false);
  });

  it('拖动选区（移动 / 控制点缩放 / 重新框选）持续刷新预览与尺寸', async () => {
    const m = mount();
    m.widget.open();
    const canvas = await readyEditor(m);
    tools(m)[0]!.click();

    pointer(canvas, 'pointerdown', 0, 0);
    pointer(canvas, 'pointermove', 16, 16);
    pointer(canvas, 'pointerup', 16, 16);
    await settled(2);

    // 1) 选区内拖动 → 移动（中心点距任一控制点足够远）
    pointer(canvas, 'pointerdown', 8, 8);
    pointer(canvas, 'pointermove', 12, 12);
    pointer(canvas, 'pointerup', 12, 12);
    await settled(2);
    let px = canvasAsPixel(canvas);
    expect(px.pixel(0, 0)).toEqual(DIM); // 选区移走后原位置被暗化
    expect(px.pixel(10, 10)).toEqual(ORANGE); // 选区内部（4,4 起 16×16，避开控制点）
    expect(m.root.querySelector('.fb-editor-result-size')?.textContent).toBe('输出尺寸：16×16 像素');

    // 2) SE 控制点缩放 → 17×17
    pointer(canvas, 'pointerdown', 20, 20);
    pointer(canvas, 'pointermove', 21, 21);
    pointer(canvas, 'pointerup', 21, 21);
    await settled(2);
    expect(m.root.querySelector('.fb-editor-result-size')?.textContent).toBe('输出尺寸：17×17 像素');
    expect(canvasAsPixel(m.root.querySelector<HTMLCanvasElement>('.fb-editor-preview')!).width).toBe(17);

    // 3) 选区外按下 = 重新框选 (0,10)-(31,31)
    pointer(canvas, 'pointerdown', 0, 31);
    pointer(canvas, 'pointermove', 31, 10);
    pointer(canvas, 'pointerup', 31, 10);
    await settled(2);
    expect(m.root.querySelector('.fb-editor-result-size')?.textContent).toBe('输出尺寸：31×21 像素');
    px = canvasAsPixel(canvas);
    expect(px.pixel(0, 0)).toEqual(DIM);
    expect(px.pixel(5, 15)).toEqual(ORANGE);
    expect(m.root.querySelector<HTMLElement>('.fb-editor-cropbar')!.hidden).toBe(false);
  });

  it('未应用选区时「保存」禁用并说明原因（点击也不生效），应用后可保存', async () => {
    const m = mount();
    m.widget.open();
    await readyEditor(m);
    const beforeUrl = m.root.querySelector<HTMLImageElement>('.fb-screenshot-thumb')!.src;

    tools(m)[0]!.click();
    const canvas = m.root.querySelector<HTMLCanvasElement>('.fb-editor-canvas')!;
    pointer(canvas, 'pointerdown', 0, 0);
    pointer(canvas, 'pointermove', 16, 16);
    pointer(canvas, 'pointerup', 16, 16);
    await settled(2);

    const save = saveBtn(m);
    const hint = m.root.querySelector<HTMLElement>('.fb-editor-save-hint')!;
    expect(save.disabled).toBe(true);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('应用裁剪');

    // 绕过禁用态直接触发点击：保存逻辑自身同样拒绝
    save.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await settled(2);
    expect(editor(m)).not.toBeNull(); // 编辑器仍打开，草稿未被写入
    expect(m.root.querySelector<HTMLImageElement>('.fb-screenshot-thumb')!.src).toBe(beforeUrl);

    // 应用裁剪 → 保存重新可用
    const cropBar = m.root.querySelector<HTMLElement>('.fb-editor-cropbar')!;
    Array.from(cropBar.querySelectorAll('button')).find((b) => b.textContent?.includes('应用'))!.click();
    await settled(2);
    expect(cropBar.hidden).toBe(true);
    expect(save.disabled).toBe(false);
    expect(hint.hidden).toBe(true);
    expect(canvasAsPixel(canvas).width).toBe(16); // 主画布展示完整裁剪结果

    save.click();
    await settled();
    expect(m.root.querySelector('.fb-editor')).toBeNull(); // 保存成功关闭
    expect(savedUrls.length).toBeGreaterThan(0);
    // 保存的是干净结果：16×16、无外部暗化写入
    const savedPng = await blobToPng(savedUrls[savedUrls.length - 1]!);
    expect(savedPng.width).toBe(16);
    expect(savedPng.height).toBe(16);
    const si = 0;
    expect([savedPng.data[si], savedPng.data[si + 1], savedPng.data[si + 2]]).toEqual([
      ORANGE[0],
      ORANGE[1],
      ORANGE[2],
    ]);
  });

  it('遮挡 → 裁剪 → 撤销 → 保存：遮挡完好、辅助边框/暗化/控制点不入图', async () => {
    const m = mount();
    m.widget.open();
    const canvas = await readyEditor(m);

    // 1) 遮挡 (4,4)-(12,12)
    tools(m)[2]!.click();
    pointer(canvas, 'pointerdown', 4, 4);
    pointer(canvas, 'pointermove', 12, 12);
    pointer(canvas, 'pointerup', 12, 12);
    await settled(2);

    // 2) 裁剪 (0,0)-(16,16) → 应用
    tools(m)[0]!.click();
    pointer(canvas, 'pointerdown', 0, 0);
    pointer(canvas, 'pointermove', 16, 16);
    pointer(canvas, 'pointerup', 16, 16);
    await settled(2);
    const cropBar = m.root.querySelector<HTMLElement>('.fb-editor-cropbar')!;
    Array.from(cropBar.querySelectorAll('button')).find((b) => b.textContent?.includes('应用'))!.click();
    await settled(2);
    expect(canvasAsPixel(canvas).width).toBe(16);
    expect(canvasAsPixel(canvas).height).toBe(16);

    // 3) 撤销裁剪 → 回到 32×32（遮挡仍在）
    const undo = tools(m).find((b) => b.textContent?.includes('撤销'))!;
    undo.click();
    await settled(2);
    expect(canvasAsPixel(canvas).width).toBe(32);
    expect(canvasAsPixel(canvas).height).toBe(32);

    // 4) 保存 → 断言最终 PNG 像素
    saveBtn(m).click();
    await settled();
    expect(m.root.querySelector('.fb-editor')).toBeNull();

    const saved = savedUrls[savedUrls.length - 1]!;
    const png = await blobToPng(saved);
    expect(png.width).toBe(32);
    expect(png.height).toBe(32);
    const at = (x: number, y: number): number[] => {
      const i = (y * png.width + x) * 4;
      return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!, png.data[i + 3]!];
    };
    // 遮挡区完好（不透明覆盖色）
    expect(at(6, 6)).toEqual([COVER.r, COVER.g, COVER.b, 255]);
    expect(at(11, 11)).toEqual([COVER.r, COVER.g, COVER.b, 255]);
    // 遮挡区外仍是原图：没有外部暗化 / 控制点 / 虚线边框被写进来
    expect(at(0, 0)).toEqual(ORANGE);
    expect(at(2, 2)).toEqual(ORANGE);
    expect(at(31, 31)).toEqual(ORANGE);
    expect(at(0, 31)).toEqual(ORANGE);
  });
});
