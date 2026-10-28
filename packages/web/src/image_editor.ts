/**
 * v12 图片编辑器（面板内全屏覆盖层）。
 *
 * 统一交互（T2，两端一致）：**调整选区 → 应用裁剪 → 保存图片**。
 * - 裁剪工具的选区在松手后**持续绘制**（边框 + 外部暗化遮罩 + 八个控制点），
 *   支持选区内拖动移动、控制点缩放、覆盖层内重新框选；
 * - 右侧（窄屏为下方）独立「裁剪结果」预览随选区同步更新，并显示输出尺寸；
 * - 存在未应用选区时**禁止保存**（禁用并说明原因），避免保存内容与预期不同；
 * - 辅助边框 / 控制点 / 棋盘网格只存在于显示层：保存走 compose()（base + ops），
 *   绝不把任何辅助元素写进输出位图。
 *
 * 工具：裁剪、矩形标注（默认红 3px 描边）、不透明遮挡（与截图遮挡同色
 * rgb(110,110,115)）、撤销、取消、保存。
 *
 * 操作模型：对基础位图依次应用有序操作列表（矩形/遮挡直接绘制在当前画布坐标系，
 * 裁剪重建画布并切换到新坐标系）；撤销 = 弹出最后一个操作并重放。
 * 自动敏感遮挡在截图时已写入位图（见 capture.ts），早于编辑器且不可逆——
 * 编辑器里不提供「恢复被自动遮挡区域」的能力，用户操作只能继续叠加。
 */

import { MASK_COVER_CSS } from './capture';

/** 矩形标注默认色（红色 3px 描边）。 */
export const ANNOTATION_COLOR = '#ff3b30';
export const ANNOTATION_WIDTH = 3;
/** 编辑器裁剪允许的最小边长（图像像素；小图仍可裁）。 */
const MIN_RECT = 4;
/** 撤销栈上限（每步为一份完整位图快照前的操作重放，天然内存友好）。 */
const MAX_OPS = 32;
/** 裁剪控制点的目标尺寸（显示像素），换算到画布像素后夹在 6..24。 */
const HANDLE_CSS_PX = 10;
const HANDLE_MIN_PX = 6;
const HANDLE_MAX_PX = 24;

export type EditorTool = 'crop' | 'rect' | 'mask';

interface EditorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 裁剪选区的八个控制点方位。 */
type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type EditorOp =
  | { type: 'crop'; rect: EditorRect }
  | { type: 'rect'; rect: EditorRect }
  | { type: 'mask'; rect: EditorRect };

export interface ImageEditorHandle {
  /** 关闭编辑器（不保存）；等价于取消。 */
  close(): void;
  /** 编辑器当前是否挂载中。 */
  readonly open: boolean;
}

export interface OpenImageEditorOptions {
  /** 已解码的图片来源（ImageBitmap / HTMLImageElement / 测试注入的绘制源）。 */
  image: CanvasImageSource;
  width: number;
  height: number;
  /** 挂载点：组件 ShadowRoot（样式与事件都在 shadow 内）。 */
  mount: ParentNode;
  /** 保存：把最终画布交给调用方（编码与限额收缩由调用方负责）。 */
  onSave: (canvas: HTMLCanvasElement) => void | Promise<void>;
  onCancel?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  if (ctx) ctx.drawImage(src, 0, 0);
  return out;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

/** 归一化拖拽选区（允许反方向拖拽）。 */
function normalizeRect(x0: number, y0: number, x1: number, y1: number): EditorRect {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

function clampRect(r: EditorRect, w: number, h: number): EditorRect | null {
  const x = Math.max(0, Math.min(r.x, w));
  const y = Math.max(0, Math.min(r.y, h));
  const x2 = Math.max(0, Math.min(r.x + r.width, w));
  const y2 = Math.max(0, Math.min(r.y + r.height, h));
  const width = x2 - x;
  const height = y2 - y;
  if (width < MIN_RECT || height < MIN_RECT) return null;
  return { x, y, width, height };
}

/** 移动选区：保持尺寸并夹回画布。 */
function moveRect(r: EditorRect, dx: number, dy: number, w: number, h: number): EditorRect {
  const x = clamp(r.x + dx, 0, Math.max(0, w - r.width));
  const y = clamp(r.y + dy, 0, Math.max(0, h - r.height));
  return { x, y, width: r.width, height: r.height };
}

/** 按控制点方位缩放选区，强制最小边长并夹回画布。 */
function resizeRect(
  r: EditorRect,
  handle: CropHandle,
  dx: number,
  dy: number,
  w: number,
  h: number,
): EditorRect {
  let left = r.x;
  let top = r.y;
  let right = r.x + r.width;
  let bottom = r.y + r.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_RECT);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_RECT, w);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_RECT);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_RECT, h);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 控制点中心坐标（画布像素）。 */
function handleCenters(r: EditorRect): Array<{ handle: CropHandle; cx: number; cy: number }> {
  const x0 = r.x;
  const xm = r.x + r.width / 2;
  const x1 = r.x + r.width;
  const y0 = r.y;
  const ym = r.y + r.height / 2;
  const y1 = r.y + r.height;
  return [
    { handle: 'nw', cx: x0, cy: y0 },
    { handle: 'n', cx: xm, cy: y0 },
    { handle: 'ne', cx: x1, cy: y0 },
    { handle: 'e', cx: x1, cy: ym },
    { handle: 'se', cx: x1, cy: y1 },
    { handle: 's', cx: xm, cy: y1 },
    { handle: 'sw', cx: x0, cy: y1 },
    { handle: 'w', cx: x0, cy: ym },
  ];
}

function insideRect(p: { x: number; y: number }, r: EditorRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/**
 * 打开全屏图片编辑器；返回句柄（close 等价于取消）。
 * 编辑期间宿主面板仍在 shadow 内：覆盖层 z-index 高于面板与放大弹窗。
 */
export function openImageEditor(opts: OpenImageEditorOptions): ImageEditorHandle {
  const { mount } = opts;

  // ---- DOM ----
  const overlay = el('div', 'fb-editor');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '编辑图片');

  const toolbar = el('div', 'fb-editor-toolbar');
  const tools = el('div', 'fb-editor-tools');
  const cropBtn = el('button', 'fb-editor-tool', '裁剪');
  const rectBtn = el('button', 'fb-editor-tool is-active', '矩形标注');
  const maskBtn = el('button', 'fb-editor-tool', '遮挡');
  const undoBtn = el('button', 'fb-editor-tool', '撤销');
  for (const b of [cropBtn, rectBtn, maskBtn, undoBtn]) {
    b.type = 'button';
  }
  cropBtn.setAttribute('aria-label', '裁剪：框选后调整选区并应用');
  cropBtn.setAttribute('aria-pressed', 'false');
  rectBtn.setAttribute('aria-label', '矩形标注：拖拽绘制红色描边矩形');
  rectBtn.setAttribute('aria-pressed', 'true');
  maskBtn.setAttribute('aria-label', '遮挡：拖拽绘制不透明遮盖块');
  maskBtn.setAttribute('aria-pressed', 'false');
  undoBtn.setAttribute('aria-label', '撤销上一步编辑');
  undoBtn.disabled = true;
  tools.append(cropBtn, rectBtn, maskBtn, undoBtn);

  const actions = el('div', 'fb-editor-actions');
  // 存在未应用选区时禁用保存的原因说明（禁用态必须说明原因）
  const saveHint = el('span', 'fb-editor-save-hint');
  saveHint.hidden = true;
  const cancelBtn = el('button', 'fb-editor-btn', '取消');
  const saveBtn = el('button', 'fb-editor-btn is-primary', '保存');
  cancelBtn.type = 'button';
  saveBtn.type = 'button';
  cancelBtn.setAttribute('aria-label', '取消编辑并关闭');
  saveBtn.setAttribute('aria-label', '保存编辑结果并替换当前图片');
  actions.append(saveHint, cancelBtn, saveBtn);
  toolbar.append(tools, actions);

  const main = el('div', 'fb-editor-main');
  const stage = el('div', 'fb-editor-stage');
  const canvas = el('canvas', 'fb-editor-canvas');
  canvas.setAttribute('aria-label', '图片编辑画布');
  stage.append(canvas);

  // T2：独立的「裁剪结果」预览 + 输出尺寸（随选区同步更新）
  const result = el('aside', 'fb-editor-result');
  result.setAttribute('aria-label', '裁剪结果预览');
  const resultTitle = el('div', 'fb-editor-result-title', '裁剪结果');
  const preview = el('canvas', 'fb-editor-preview');
  preview.setAttribute('aria-label', '裁剪结果');
  const resultSize = el('div', 'fb-editor-result-size', '');
  result.append(resultTitle, preview, resultSize);
  main.append(stage, result);

  const cropBar = el('div', 'fb-editor-cropbar');
  cropBar.hidden = true;
  const cropHint = el('span', 'fb-editor-crop-hint', '已框选裁剪区域：可拖动调整，或重新框选');
  const cropApply = el('button', 'fb-editor-btn is-primary', '应用裁剪');
  const cropCancel = el('button', 'fb-editor-btn', '取消裁剪');
  cropApply.type = 'button';
  cropCancel.type = 'button';
  cropApply.setAttribute('aria-label', '应用当前裁剪选区');
  cropCancel.setAttribute('aria-label', '取消当前裁剪选区');
  cropBar.append(cropHint, cropApply, cropCancel);

  const hint = el(
    'p',
    'fb-editor-hint',
    '自动遮挡的敏感区域已写入图片，无法通过编辑恢复；辅助边框与控制点不会写入图片；保存将替换当前图片，不占用新的图片名额。',
  );

  overlay.append(toolbar, main, cropBar, hint);

  // ---- 状态 ----
  const base = document.createElement('canvas');
  base.width = Math.max(1, Math.round(opts.width));
  base.height = Math.max(1, Math.round(opts.height));
  {
    const ctx = base.getContext('2d');
    if (ctx) ctx.drawImage(opts.image, 0, 0, base.width, base.height);
  }

  let tool: EditorTool = 'rect';
  const ops: EditorOp[] = [];
  let pendingCrop: EditorRect | null = null;
  let dragging = false;
  let dragStart: { x: number; y: number } | null = null;
  let dragNow: { x: number; y: number } | null = null;
  /** 对待确认选区的移动 / 缩放（区别于「新框选」dragging）。 */
  let cropDrag:
    | { mode: 'move' | 'resize'; handle?: CropHandle; startX: number; startY: number; startRect: EditorRect }
    | null = null;
  let mounted = true;
  let saving = false;

  /**
   * 干净的输出位图：base + 有序操作（与显示分离）。
   * 保存与结果预览都基于它——辅助边框 / 控制点 / 网格绝不进入输出。
   */
  function compose(): HTMLCanvasElement {
    let cur = cloneCanvas(base);
    for (const op of ops) {
      const ctx = cur.getContext('2d');
      if (!ctx) continue;
      if (op.type === 'crop') {
        const next = document.createElement('canvas');
        next.width = Math.max(1, Math.round(op.rect.width));
        next.height = Math.max(1, Math.round(op.rect.height));
        const nctx = next.getContext('2d');
        if (nctx) {
          nctx.drawImage(
            cur,
            Math.round(op.rect.x),
            Math.round(op.rect.y),
            Math.round(op.rect.width),
            Math.round(op.rect.height),
            0,
            0,
            next.width,
            next.height,
          );
        }
        cur = next;
      } else if (op.type === 'rect') {
        ctx.save();
        ctx.strokeStyle = ANNOTATION_COLOR;
        ctx.lineWidth = ANNOTATION_WIDTH;
        ctx.strokeRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height);
        ctx.restore();
      } else {
        ctx.save();
        ctx.fillStyle = MASK_COVER_CSS;
        ctx.fillRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height);
        ctx.restore();
      }
    }
    return cur;
  }

  /** 控制点尺寸：按画布显示比例换算，且不超过选区最小边的 1/3。 */
  function handleSize(r: EditorRect): number {
    const box = canvas.getBoundingClientRect();
    const scale = box.width > 0 ? canvas.width / box.width : 1;
    const raw = Math.round(HANDLE_CSS_PX * scale);
    const capped = clamp(raw, HANDLE_MIN_PX, HANDLE_MAX_PX);
    return Math.max(2, Math.min(capped, Math.floor(Math.min(r.width, r.height) / 3) || 2));
  }

  function hitHandle(p: { x: number; y: number }, r: EditorRect): CropHandle | null {
    const hs = handleSize(r);
    for (const c of handleCenters(r)) {
      if (Math.abs(p.x - c.cx) <= hs / 2 + 2 && Math.abs(p.y - c.cy) <= hs / 2 + 2) return c.handle;
    }
    return null;
  }

  /** 持续绘制裁剪选区：外部暗化 + 虚线边框 + 八个控制点（仅显示层）。 */
  function drawCropFrame(dctx: CanvasRenderingContext2D, r: EditorRect): void {
    const w = canvas.width;
    const h = canvas.height;
    dctx.save();
    dctx.fillStyle = 'rgba(0,0,0,0.45)';
    dctx.fillRect(0, 0, w, r.y);
    dctx.fillRect(0, r.y + r.height, w, h - r.y - r.height);
    dctx.fillRect(0, r.y, r.x, r.height);
    dctx.fillRect(r.x + r.width, r.y, w - r.x - r.width, r.height);
    dctx.strokeStyle = '#ffffff';
    dctx.lineWidth = 1;
    dctx.setLineDash([6, 4]);
    dctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width, r.height);
    dctx.setLineDash([]);
    const hs = handleSize(r);
    dctx.fillStyle = '#ffffff';
    for (const c of handleCenters(r)) {
      dctx.fillRect(c.cx - hs / 2, c.cy - hs / 2, hs, hs);
    }
    dctx.strokeStyle = 'rgba(0,0,0,0.65)';
    for (const c of handleCenters(r)) {
      dctx.strokeRect(c.cx - hs / 2, c.cy - hs / 2, hs, hs);
    }
    dctx.restore();
  }

  /** 「裁剪结果」预览：有待确认选区时显示裁剪结果，否则显示当前完整结果。 */
  function updatePreview(clean: HTMLCanvasElement): void {
    const r = pendingCrop;
    const w = Math.max(1, Math.round(r ? r.width : clean.width));
    const h = Math.max(1, Math.round(r ? r.height : clean.height));
    preview.width = w;
    preview.height = h;
    const pctx = preview.getContext('2d');
    if (pctx) {
      if (r) {
        pctx.drawImage(clean, Math.round(r.x), Math.round(r.y), w, h, 0, 0, w, h);
      } else {
        pctx.drawImage(clean, 0, 0);
      }
    }
    resultSize.textContent = `输出尺寸：${w}×${h} 像素`;
  }

  /** 存在未应用选区时禁止保存，并说明原因。 */
  function syncSaveState(): void {
    const blocked = pendingCrop !== null;
    saveBtn.disabled = saving || blocked;
    saveHint.hidden = !blocked;
    saveHint.textContent = blocked ? '请先「应用裁剪」或「取消裁剪」后再保存' : '';
    if (blocked) saveBtn.title = '存在未应用的裁剪选区';
    else saveBtn.removeAttribute('title');
  }

  // ---- 渲染：clean（base → ops）→ 画布 + 显示层辅助元素 ----
  function render(): void {
    if (!mounted) return;
    const clean = compose();
    canvas.width = clean.width;
    canvas.height = clean.height;
    const dctx = canvas.getContext('2d');
    if (dctx) dctx.drawImage(clean, 0, 0);

    // 新框选（任意工具拖拽中的临时预览）
    const freshRect =
      dragging && dragStart && dragNow
        ? clampRect(normalizeRect(dragStart.x, dragStart.y, dragNow.x, dragNow.y), canvas.width, canvas.height)
        : null;

    if (dctx) {
      if (tool === 'crop') {
        // 松手后选区**持续显示**（T2.1）：待确认选区或正在框选的新选区
        const rect = freshRect ?? pendingCrop;
        if (rect) drawCropFrame(dctx, rect);
      } else if (freshRect && dctx) {
        if (tool === 'rect') {
          dctx.strokeStyle = ANNOTATION_COLOR;
          dctx.lineWidth = ANNOTATION_WIDTH;
          dctx.strokeRect(freshRect.x, freshRect.y, freshRect.width, freshRect.height);
        } else {
          dctx.fillStyle = MASK_COVER_CSS;
          dctx.fillRect(freshRect.x, freshRect.y, freshRect.width, freshRect.height);
        }
      }
    }

    undoBtn.disabled = ops.length === 0;
    cropBar.hidden = pendingCrop === null;
    updatePreview(clean);
    syncSaveState();
  }

  function setTool(next: EditorTool): void {
    tool = next;
    cropBtn.classList.toggle('is-active', next === 'crop');
    rectBtn.classList.toggle('is-active', next === 'rect');
    maskBtn.classList.toggle('is-active', next === 'mask');
    cropBtn.setAttribute('aria-pressed', String(next === 'crop'));
    rectBtn.setAttribute('aria-pressed', String(next === 'rect'));
    maskBtn.setAttribute('aria-pressed', String(next === 'mask'));
    // 切换工具时丢弃未确认的裁剪选区
    if (next !== 'crop' && pendingCrop) {
      pendingCrop = null;
      cropDrag = null;
      cropBar.hidden = true;
      render();
    }
    canvas.style.cursor = 'crosshair';
  }

  // ---- 指针坐标 → 画布像素 ----
  function toCanvasPoint(ev: PointerEvent): { x: number; y: number } {
    const box = canvas.getBoundingClientRect();
    const scaleX = box.width > 0 ? canvas.width / box.width : 1;
    const scaleY = box.height > 0 ? canvas.height / box.height : 1;
    return {
      x: Math.round((ev.clientX - box.left) * scaleX),
      y: Math.round((ev.clientY - box.top) * scaleY),
    };
  }

  function beginPointer(ev: PointerEvent): void {
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* happy-dom 或旧浏览器无 pointer capture */
    }
    ev.preventDefault();
  }

  canvas.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (saving || ev.button !== 0) return;
    const pt = toCanvasPoint(ev);

    if (tool === 'crop' && pendingCrop) {
      const handle = hitHandle(pt, pendingCrop);
      if (handle) {
        cropDrag = {
          mode: 'resize',
          handle,
          startX: pt.x,
          startY: pt.y,
          startRect: { ...pendingCrop },
        };
        beginPointer(ev);
        return;
      }
      if (insideRect(pt, pendingCrop)) {
        cropDrag = { mode: 'move', startX: pt.x, startY: pt.y, startRect: { ...pendingCrop } };
        beginPointer(ev);
        return;
      }
      // 选区外按下 = 重新框选：丢弃旧选区，从落点开始新的框选
      pendingCrop = null;
      cropBar.hidden = true;
      cropDrag = null;
      syncSaveState();
    }

    dragging = true;
    dragStart = pt;
    dragNow = pt;
    beginPointer(ev);
    render();
  });

  canvas.addEventListener('pointermove', (ev: PointerEvent) => {
    if (cropDrag) {
      const pt = toCanvasPoint(ev);
      const d = cropDrag;
      pendingCrop =
        d.mode === 'move'
          ? moveRect(d.startRect, pt.x - d.startX, pt.y - d.startY, canvas.width, canvas.height)
          : resizeRect(
              d.startRect,
              d.handle ?? 'se',
              pt.x - d.startX,
              pt.y - d.startY,
              canvas.width,
              canvas.height,
            );
      render();
      return;
    }
    if (!dragging || !dragStart) return;
    dragNow = toCanvasPoint(ev);
    render();
  });

  const finishDrag = (ev: PointerEvent, cancelled: boolean): void => {
    if (cropDrag) {
      cropDrag = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        /* 指针捕获可能已自动释放 */
      }
      render();
      return;
    }
    if (!dragging || !dragStart) return;
    dragging = false;
    const end = cancelled ? dragStart : toCanvasPoint(ev);
    const r = clampRect(
      normalizeRect(dragStart.x, dragStart.y, end.x, end.y),
      canvas.width,
      canvas.height,
    );
    dragStart = null;
    dragNow = null;
    if (!r) {
      render();
      return;
    }
    if (tool === 'crop') {
      // 裁剪进入待确认态：选区持续显示，可继续调整 → 应用 / 取消
      pendingCrop = r;
      cropBar.hidden = false;
      render();
      return;
    }
    ops.push({ type: tool === 'rect' ? 'rect' : 'mask', rect: r });
    if (ops.length > MAX_OPS) ops.shift();
    render();
  };

  canvas.addEventListener('pointerup', (ev: PointerEvent) => finishDrag(ev, false));
  canvas.addEventListener('pointercancel', (ev: PointerEvent) => finishDrag(ev, true));

  cropApply.addEventListener('click', () => {
    if (!pendingCrop) return;
    ops.push({ type: 'crop', rect: pendingCrop });
    pendingCrop = null;
    cropBar.hidden = true;
    if (ops.length > MAX_OPS) ops.shift();
    render();
  });
  cropCancel.addEventListener('click', () => {
    pendingCrop = null;
    cropBar.hidden = true;
    render();
  });

  undoBtn.addEventListener('click', () => {
    if (pendingCrop) {
      pendingCrop = null;
      cropBar.hidden = true;
      render();
      return;
    }
    ops.pop();
    render();
  });

  cropBtn.addEventListener('click', () => setTool('crop'));
  rectBtn.addEventListener('click', () => setTool('rect'));
  maskBtn.addEventListener('click', () => setTool('mask'));

  const close = (): void => {
    if (!mounted) return;
    mounted = false;
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    opts.onCancel?.();
  };

  const save = async (): Promise<void> => {
    if (saving || pendingCrop !== null) return; // 未应用选区时禁止保存
    saving = true;
    syncSaveState();
    saveBtn.textContent = '保存中…';
    try {
      // 保存干净的输出位图（base + ops），辅助元素绝不写入
      await opts.onSave(compose());
      // 保存成功后由调用方 close（handle.close）；失败时保持打开供重试
    } finally {
      saving = false;
      if (mounted) {
        saveBtn.textContent = '保存';
        syncSaveState();
      }
    }
  };

  saveBtn.addEventListener('click', () => void save());
  cancelBtn.addEventListener('click', close);

  const onKeydown = (ev: KeyboardEvent): void => {
    if (!mounted) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (pendingCrop) {
        // Esc 优先取消未应用的选区（而不是关闭编辑器）
        pendingCrop = null;
        cropBar.hidden = true;
        render();
      } else {
        close();
      }
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      ev.stopPropagation();
      undoBtn.click();
    }
  };
  // capture 阶段优先于宿主面板自己的 Esc 处理
  document.addEventListener('keydown', onKeydown, true);

  mount.appendChild(overlay);
  render();
  setTool('rect');

  const handle: ImageEditorHandle = {
    close,
    get open() {
      return mounted;
    },
  };
  return handle;
}
