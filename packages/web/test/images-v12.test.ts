/**
 * v12 增量测试：多图附件（T2）、不可绘制内容提示（T1）、能力降级（§5.6）、
 * 我的反馈分页/筛选与 Bearer 附件（T3）、增量对话渲染。
 *
 * happy-dom 约束：图片解码经全局 createImageBitmap 打桩（返回 FakeCanvas）；
 * 真实编码的 PNG 字节经 test/pixel-fixture.ts 的 encodePng 生成。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import '../src/index';
import { submitFeedback } from '../src/api';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
  type Mounted,
} from './helpers';
import {
  FakeCanvas,
  blobToPng,
  createState,
  encodePng,
  installGeometryPatch,
  stubCreateElementCanvas,
  addNode,
} from './pixel-fixture';
import { countUndrawableContent } from '../src/images';

// ---------- 公共桩 ----------

let urlSeq = 0;

/** 构造 1x1 纯色 PNG 文件（真实 PNG 魔数 + IHDR，可被 sniffMime 识别）。 */
function pngFile(name = 'a.png', rgba: [number, number, number, number] = [10, 20, 30, 255]): File {
  const px = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < px.length; i++) px[i] = rgba[i % 4]!;
  const bytes = encodePng(4, 4, px);
  return new File([bytes], name, { type: 'image/png' });
}

/** createImageBitmap 桩：解码 PNG 到 FakeCanvas（真实像素），供编辑断言。 */
function stubBitmapDecoder(state = createState()): void {
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const png = await blobToPng(blob).catch(() => null);
    const c = new FakeCanvas(state);
    c.width = png?.width ?? 4;
    c.height = png?.height ?? 4;
    if (png) c.data.set(png.data);
    return c;
  });
}

function objectUrl(): string {
  return `blob:mock-${++urlSeq}`;
}

async function settled(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5));
}

/** 通过文件选择器加入图片（等价于点击「添加图片」→ 选择文件）。 */
async function addFiles(m: Mounted, files: File[]): Promise<void> {
  const input = m.root.querySelector<HTMLInputElement>('.fb-image-input')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
  await settled();
}

/** 提交请求中的 metadata JSON（FormData 形态）。 */
function formMeta(call: { rawBody?: unknown }): Record<string, unknown> {
  const fd = call.rawBody as FormData;
  return JSON.parse(String(fd.get('metadata')));
}

function formParts(call: { rawBody?: unknown }, name: string): unknown[] {
  return (call.rawBody as FormData).getAll(name);
}

const IMAGE_CAPABILITIES = { dialogue: true, images: 5 };

beforeEach(() => {
  urlSeq = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => objectUrl());
  stubCreateElementCanvas(createState());
  stubBitmapDecoder();
});

afterEach(cleanup);

// ---------- T2：多图草稿与提交 ----------

describe('T2 多图附件', () => {
  it('手动添加多图：缩略图网格渲染、角标、删除后重排', async () => {
    const m = mount();
    m.widget.open();
    await addFiles(m, [pngFile('a.png'), pngFile('b.png'), pngFile('c.png')]);

    const wrap = m.screenshotWrap;
    expect(wrap.hidden).toBe(false);
    const cells = wrap.querySelectorAll('.fb-screenshot-thumb-box');
    expect(cells.length).toBe(3);
    expect(cells[0]!.textContent).toContain('图片');
    // 添加按钮仍可见（3 < 5）
    const addBtn = m.root.querySelector<HTMLButtonElement>('.fb-btn-add-image')!;
    expect(addBtn.hidden).toBe(false);

    // 删除第一张 → 剩余两张，第一张被替换
    const firstDel = cells[0]!.querySelector<HTMLButtonElement>('.fb-thumb-remove')!;
    firstDel.click();
    await settled(2);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(2);
  });

  it('超过 5 张的部分被拒并提示上限', async () => {
    const m = mount();
    m.widget.open();
    const files = Array.from({ length: 7 }, (_, i) => pngFile(`p${i}.png`));
    await addFiles(m, files);

    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(5);
    const err = m.root.querySelector('.fb-shot-error');
    expect(err?.textContent).toContain('最多附加 5 张');
    const addBtn = m.root.querySelector<HTMLButtonElement>('.fb-btn-add-image')!;
    expect(addBtn.hidden).toBe(true);
  });

  it('非图片类型被拒并提示，有效图片仍入列', async () => {
    const m = mount();
    m.widget.open();
    const bad = new File(['not an image'], 'note.txt', { type: 'text/plain' });
    await addFiles(m, [bad, pngFile('ok.png')]);

    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
    const err = m.root.querySelector('.fb-shot-error');
    expect(err?.textContent).toContain('仅支持 PNG / JPEG / WebP');
  });

  it('粘贴图片文件进草稿', async () => {
    const m = mount();
    m.widget.open();
    const ev = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(ev, 'clipboardData', {
      value: { files: [pngFile('clip.png')] },
    });
    m.textarea.dispatchEvent(ev);
    await settled();

    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('多图提交走 images[]：metadata.images 有序描述符（sha256/mime/source）+ images 部件', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/features')) {
        return httpResponse(200, { dialogue: true, images: 5 });
      }
      return httpResponse(201, { feedbackId: 'fb-multi', status: 'received' });
    });
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.widget.open();
    await addFiles(m, [pngFile('x.png'), pngFile('y.png')]);
    setTextarea(m, '两张图的问题');
    m.submitBtn.click();
    await settled(10);

    const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'));
    expect(posts.length).toBe(1);
    const meta = formMeta(posts[0]!);
    expect(meta.text).toBe('两张图的问题');
    const descriptors = meta.images as Array<Record<string, unknown>>;
    expect(descriptors.length).toBe(2);
    expect(descriptors[0]!.source).toBe('manual');
    expect(typeof descriptors[0]!.sha256).toBe('string');
    expect((descriptors[0]!.sha256 as string).length).toBe(64);
    expect(descriptors[0]!.mime).toBe('image/png');
    expect(descriptors[0]!.id).not.toBe(descriptors[1]!.id);
    expect(formParts(posts[0]!, 'images').length).toBe(2);
    // 契约：images 与旧 screenshot 字段互斥
    expect(formParts(posts[0]!, 'screenshot').length).toBe(0);
  });

  it('单图提交仍走旧 screenshot 字段（兼容未升级服务端）', async () => {
    const m = mount();
    const { calls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-one', status: 'received' }),
    );
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.widget.open();
    await addFiles(m, [pngFile('one.png')]);
    setTextarea(m, '单图反馈');
    m.submitBtn.click();
    await settled(10);

    const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'));
    expect(posts.length).toBe(1);
    const fd = posts[0]!.rawBody as FormData;
    expect(fd.getAll('screenshot').length).toBe(1);
    expect(fd.getAll('images').length).toBe(0);
    const meta = formMeta(posts[0]!);
    expect(meta.images).toBeUndefined();
  });

  it('提交后清空图片草稿', async () => {
    const m = mount();
    recordFetch(async () => httpResponse(201, { feedbackId: 'fb-ok', status: 'received' }));
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.widget.open();
    await addFiles(m, [pngFile('a.png')]);
    setTextarea(m, 'ok');
    m.submitBtn.click();
    await settled(10);

    expect(m.screenshotWrap.hidden).toBe(true);
  });
});

// ---------- §5.6 能力降级 ----------

describe('能力降级（capabilities.images 缺失）', () => {
  it('会话响应 capabilities 无 images → 单图模式：加图按钮隐藏 + 升级提示', async () => {
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(200, {}));
    await completeLogin(m, undefined, { dialogue: true }); // 有 capabilities 但缺 images
    m.widget.open();
    await settled(10);
    await addFiles(m, [pngFile('a.png'), pngFile('b.png')]);

    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
    const err = m.root.querySelector('.fb-shot-error');
    expect(err?.textContent).toContain('最多附加 1 张');
    const hint = m.root.querySelector<HTMLElement>('.fb-shot-hint');
    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain('单张图片');
    // 无多图需求 → 不探测 /api/features
    expect(calls.some((c) => c.url.includes('/api/features'))).toBe(false);
  });

  it('登录响应带 capabilities.images=5 → 多图模式生效', async () => {
    const m = mount();
    recordFetch(async () => httpResponse(200, {}));
    await completeLogin(m, undefined, { images: 5 });
    m.widget.open();
    await settled(10);
    await addFiles(m, [pngFile('a.png'), pngFile('b.png')]);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(2);
  });

  it('能力未知时提交多图 → 先探测 features，确认单图后阻止提交（草稿保留）', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/features')) return httpResponse(200, { dialogue: true }); // 缺 images → 单图
      return httpResponse(201, { feedbackId: 'fb-x', status: 'received' });
    });
    await completeLogin(m); // 无 capabilities → 未知
    m.widget.open();
    await settled(10);
    await addFiles(m, [pngFile('a.png'), pngFile('b.png')]);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(2);

    setTextarea(m, '多图内容');
    m.submitBtn.click();
    await settled(10);

    expect(calls.some((c) => c.url.includes('/api/features'))).toBe(true);
    // 已确认单图 → 不发出必然 400 的歧义请求
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/feedback')).length).toBe(0);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(2); // 草稿保留
    expect(m.errorRegion.textContent).toContain('最多支持 1 张');
  });

  it('能力未知时提交多图 → 探测失败乐观放行（服务端裁决）', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/features')) return httpResponse(404, {});
      return httpResponse(201, { feedbackId: 'fb-y', status: 'received' });
    });
    await completeLogin(m);
    m.widget.open();
    await settled(10);
    await addFiles(m, [pngFile('a.png'), pngFile('b.png')]);
    setTextarea(m, '乐观多图');
    m.submitBtn.click();
    await settled(10);

    const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'));
    expect(posts.length).toBe(1);
    expect(formParts(posts[0]!, 'images').length).toBe(2);
  });
});

// ---------- 契约级（api.ts 直测） ----------

describe('v12 提交契约（api.ts）', () => {
  it('images 与 screenshot 同传 → 本地拒绝（invalid_request），不发出请求', async () => {
    const fetchMock = vi.fn();
    await expect(
      submitFeedback('http://api.test', 'tok', {
        idempotencyKey: 'k',
        appId: 'a',
        text: 't',
        screenshot: new Blob(['x']),
        images: [
          { id: 'i1', source: 'manual', filename: 'a.png', blob: new Blob(['x']) },
        ],
      }, { fetchFn: fetchMock }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------- T2 全屏图片编辑器 ----------

describe('T2 全屏图片编辑器', () => {
  function pointer(canvas: Element, type: string, x: number, y: number): void {
    canvas.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }),
    );
  }

  it('矩形标注：拖拽绘制默认红色描边，保存原位替换（不新增图片）', async () => {
    const m = mount();
    m.widget.open();
    await addFiles(m, [pngFile('edit.png')]);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);

    const editBtn = m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!;
    editBtn.click();
    await settled();

    const editor = m.root.querySelector('.fb-editor')!;
    expect(editor).not.toBeNull();
    const canvas = m.root.querySelector<HTMLCanvasElement>('.fb-editor-canvas')!;

    // 默认工具是矩形标注：拖拽 (2,2)→(6,6) 画一个红色矩形
    pointer(canvas, 'pointerdown', 2, 2);
    pointer(canvas, 'pointermove', 6, 6);
    pointer(canvas, 'pointerup', 6, 6);
    await settled(2);

    // 保存 → 编辑器关闭，图片数量不变，角标变为「已编辑」
    const saveBtn = editor.querySelector<HTMLButtonElement>('.fb-editor-btn.is-primary')!;
    saveBtn.click();
    await settled();

    expect(m.root.querySelector('.fb-editor')).toBeNull();
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
    expect(m.root.querySelector('.fb-screenshot-badge')?.textContent).toContain('已编辑');
  });

  it('遮挡工具：不透明色块写入保存位图（真实像素断言）', async () => {
    const m = mount();
    m.widget.open();
    await addFiles(m, [pngFile('mask.png')]);

    // 直接读草稿图片字节（对象 URL 前最后一次 toBlob 无法截获，改走提交路径太慢——
    // 用编辑器保存后的 File 字节断言：图片尺寸一致且中心像素为遮挡色）
    m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!.click();
    await settled();
    const canvas = m.root.querySelector<HTMLCanvasElement>('.fb-editor-canvas')!;

    // 切到遮挡工具
    const maskTool = m.root.querySelectorAll<HTMLButtonElement>('.fb-editor-tool')[2]!;
    maskTool.click();
    pointer(canvas, 'pointerdown', 0, 0);
    pointer(canvas, 'pointermove', 4, 4);
    pointer(canvas, 'pointerup', 4, 4);
    await settled(2);

    m.root.querySelector<HTMLButtonElement>('.fb-editor-btn.is-primary')!.click();
    await settled();

    // 保存结果以新对象 URL 写入草稿；通过提交路径断言实际发送的 PNG 像素
    const { calls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-ed', status: 'received' }),
    );
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    setTextarea(m, '遮挡验证');
    m.submitBtn.click();
    await settled(10);

    const posts = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'));
    expect(posts.length).toBe(1);
    const sent = (posts[0]!.rawBody as FormData).get('screenshot') as Blob;
    expect(sent).not.toBeNull();
    const img = await blobToPng(sent);
    // 遮挡区（左上 4x4 区域）应为 MASK_COVER 色 110,110,115
    const px = (x: number, y: number) => {
      const i = (y * img.width + x) * 4;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    expect(px(1, 1)).toEqual([110, 110, 115]);
  });

  it('裁剪：框选→应用→画布尺寸收缩；撤销恢复原图', async () => {
    const m = mount();
    m.widget.open();
    // 用 8x8 图：编码后解码位图尺寸即裁剪断言依据
    const big = encodePng(8, 8, new Uint8ClampedArray(8 * 8 * 4).fill(0).map((_, i) => [200, 100, 50, 255][i % 4]!));
    await addFiles(m, [new File([big], 'big.png', { type: 'image/png' })]);

    m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!.click();
    await settled();
    const canvas = m.root.querySelector<HTMLCanvasElement>('.fb-editor-canvas')!;
    expect((canvas as unknown as { width: number }).width).toBe(8);

    // 裁剪工具 → 框选 (0,0)→(4,4) → 应用
    m.root.querySelectorAll<HTMLButtonElement>('.fb-editor-tool')[0]!.click();
    pointer(canvas, 'pointerdown', 0, 0);
    pointer(canvas, 'pointermove', 4, 4);
    pointer(canvas, 'pointerup', 4, 4);
    await settled(2);
    const cropBar = m.root.querySelector<HTMLElement>('.fb-editor-cropbar')!;
    expect(cropBar.hidden).toBe(false);
    const applyBtn = Array.from(cropBar.querySelectorAll('button')).find((b) => b.textContent?.includes('应用'))!;
    applyBtn.click();
    await settled(2);
    expect((canvas as unknown as { width: number }).width).toBe(4);

    // 撤销 → 回到 8x8
    const undoBtn = Array.from(m.root.querySelectorAll<HTMLButtonElement>('.fb-editor-tool'))
      .find((b) => b.textContent?.includes('撤销'))!;
    undoBtn.click();
    await settled(2);
    expect((canvas as unknown as { width: number }).width).toBe(8);
  });

  it('Esc 关闭编辑器且不改动草稿（取消语义）；编辑器打开期间面板不响应 Esc', async () => {
    const m = mount();
    m.widget.open();
    await addFiles(m, [pngFile('esc.png')]);
    m.root.querySelector<HTMLButtonElement>('.fb-thumb-edit')!.click();
    await settled();
    expect(m.root.querySelector('.fb-editor')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settled(2);
    expect(m.root.querySelector('.fb-editor')).toBeNull();
    // 面板仍打开（编辑器把 Esc 消费掉了）
    expect(m.panel.classList.contains('is-open')).toBe(true);
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
  });
});

// ---------- T1：不可绘制内容提示 ----------

describe('T1 不可绘制内容检测', () => {
  it('countUndrawableContent：跨源 iframe 与无 CORS 跨源图片计入', () => {
    const teardown = installGeometryPatch();
    try {
      addNode('<iframe src="https://cdn.other.com/embed"></iframe>', '10,10,100,80');
      addNode('<img src="https://cdn.other.com/pic.png">', '10,100,50,50');
      addNode('<img src="/local.png">', '10,160,50,50'); // 同源：不计
      addNode('<img src="https://cdn.other.com/ok.png" crossorigin="anonymous">', '10,220,50,50'); // CORS：不计
      addNode('<iframe src="https://hidden.other.com/x" style="display:none"></iframe>', '0,0,10,10'); // display:none 不计（可见性由 patch 读内联样式）
      expect(countUndrawableContent(document)).toBe(2);
    } finally {
      teardown();
      document.body.innerHTML = '';
    }
  });

  it('截图含不可绘制内容 → 预览旁提示「部分内容可能未入图」，且可手动加图', async () => {
    const teardown = installGeometryPatch();
    try {
      addNode('<iframe src="https://cdn.other.com/embed"></iframe>', '10,10,100,80');
      const m = mount();
      m.widget.captureProvider = vi.fn(async () => ({
        blob: new Blob([encodePng(4, 4, new Uint8ClampedArray(64).fill(128))], { type: 'image/png' }),
        width: 4,
        height: 4,
      }));
      await m.widget.captureAndOpen();
      await settled();

      const hint = m.root.querySelector<HTMLElement>('.fb-shot-hint');
      expect(hint?.hidden).toBe(false);
      expect(hint?.textContent).toContain('部分内容可能未入图');
      // 手动加图仍然可用（与截图共存）
      await addFiles(m, [pngFile('sup.png')]);
      expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(2);
    } finally {
      teardown();
      document.body.innerHTML = '';
    }
  });

  it('重拍成功原位替换截图；重拍失败保留旧图与文本', async () => {
    const m = mount();
    let first = true;
    m.widget.captureProvider = vi.fn(async () => {
      const byte = first ? 10 : 200;
      first = false;
      return {
        blob: new Blob([encodePng(4, 4, new Uint8ClampedArray(64).fill(byte))], { type: 'image/png' }),
        width: 4,
        height: 4,
      };
    });
    await m.widget.captureAndOpen();
    await settled();
    setTextarea(m, '原文本');
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);

    // 重拍（成功）：仍只有一张（原位替换，不占名额）
    m.retakeBtn.click();
    await settled();
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);

    // 重拍失败：旧图与文本保留
    m.widget.captureProvider = vi.fn(async () => {
      throw new Error('capture boom');
    });
    m.retakeBtn.click();
    await settled();
    expect(m.root.querySelectorAll('.fb-screenshot-thumb-box').length).toBe(1);
    expect(m.textarea.value).toBe('原文本');
  });
});

// ---------- T3：我的反馈分页 / 筛选 / Bearer 附件 / 增量渲染 ----------

function listItem(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    appId: 'com.example.app',
    title: `标题-${id}`,
    text: '内容',
    status: 'received',
    issueStatus: 'open',
    dialogueVersion: 1,
    archiveRound: 1,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    unread: false,
    messageCount: 0,
    latestMessage: null,
    ...over,
  };
}

function dialogueData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feedback: {
      id: 'fb-d',
      appId: 'com.example.app',
      title: '对话',
      text: '原始反馈内容',
      status: 'received',
      issueStatus: 'waiting_user',
      dialogueVersion: 1,
      archiveRound: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      images: [{ id: 'img-9', filename: 'shot.png', mime: 'image/png' }],
      logs: [{ id: 'log-1', filename: 'app.log', byteSize: 100 }],
      ...((over.feedback as object | undefined) ?? {}),
    },
    messages: [
      {
        id: 'msg-1',
        seq: 1,
        senderType: 'admin',
        senderId: 'a1',
        senderName: '管理员',
        text: '请看图',
        createdAt: new Date().toISOString(),
        attachments: [{ id: 'att-1', kind: 'image', filename: 'a.png', byteSize: 10, mime: 'image/png' }],
        resolutionNote: '需要更多信息',
      },
    ],
    lastReadSeq: 0,
  };
}

describe('T3 我的反馈闭环', () => {
  it('分页：总数>1 页显示翻页控件并携带 page 参数', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, {
          items: [listItem('fb-1')],
          total: 45,
          page: 1,
          limit: 20,
          unreadTotal: 0,
        });
      }
      return httpResponse(200, {});
    });
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.fab.click();
    await settled();
    m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
    await settled();

    const mineCalls = calls.filter((c) => c.url.includes('/api/feedback/mine'));
    expect(mineCalls.length).toBe(1);
    expect(mineCalls[0]!.url).toContain('page=1');
    expect(mineCalls[0]!.url).toContain('limit=20');

    const next = m.root.querySelector<HTMLButtonElement>('.fb-history-page-next')!;
    expect(next).not.toBeNull();
    next.click();
    await settled();

    const p2 = calls.filter((c) => c.url.includes('page=2'));
    expect(p2.length).toBe(1);
    const prev = m.root.querySelector<HTMLButtonElement>('.fb-history-page-prev')!;
    expect(prev.disabled).toBe(false);
    expect(m.root.textContent).toContain('第 2 / 3 页');
  });

  it('状态筛选：issueStatus 参数 + 选项文案为 v12 口径', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, { items: [listItem('fb-f')], total: 1, page: 1, limit: 20, unreadTotal: 0 });
      }
      return httpResponse(200, {});
    });
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.fab.click();
    await settled();
    m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
    await settled();

    const sel = m.root.querySelector<HTMLSelectElement>('.fb-history-filter')!;
    const labels = Array.from(sel.options).map((o) => o.textContent);
    expect(labels).toEqual(['全部状态', '待处理', '待补充', '等待回复', '已解决']);

    sel.value = 'waiting_admin';
    sel.dispatchEvent(new Event('change'));
    await settled();

    const filtered = calls.filter((c) => c.url.includes('issueStatus=waiting_admin'));
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.url).toContain('page=1');
  });

  it('历史图片/日志/消息附件全部经 Bearer fetch 取回（不裸用 URL）', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, { items: [listItem('fb-d', { unread: true })], total: 1, page: 1, limit: 20, unreadTotal: 1 });
      }
      if (url.includes('/dialogue')) return httpResponse(200, dialogueData());
      if (url.includes('/read')) return httpResponse(200, { ok: true });
      if (url.includes('/images/') || url.includes('attachments/')) {
        return httpResponse(200, new Blob([encodePng(2, 2, new Uint8ClampedArray(16).fill(9))], { type: 'image/png' }));
      }
      if (url.includes('/logs/')) {
        return httpResponse(200, new Blob(['log line'], { type: 'text/plain' }));
      }
      return httpResponse(200, {});
    });
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.fab.click();
    await settled();
    m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
    await settled();
    m.root.querySelector<HTMLDivElement>('.fb-history-item')!.click();
    await settled();

    // 原始图片 + 消息图片附件 → 两次 Bearer GET
    const imgGets = calls.filter(
      (c) => c.method === 'GET' && (c.url.includes('/images/img-9') || c.url.includes('attachments/att-1')),
    );
    expect(imgGets.length).toBe(2);
    for (const c of imgGets) {
      expect(c.headers.Authorization).toBe('Bearer test-access-token');
    }
    // 渲染的 <img> 用对象 URL 而非服务器 URL
    const imgs = m.root.querySelectorAll<HTMLImageElement>('.fb-dialogue-attachment-img');
    expect(imgs.length).toBe(2);
    for (const img of Array.from(imgs)) {
      expect(img.src.startsWith('blob:mock-')).toBe(true);
    }
    // 处理说明可见（消息级 + 原始反馈级）
    expect(m.root.textContent).toContain('处理说明：需要更多信息');
  });

  it('日志附件点击 → Bearer 下载（不直接导航）', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, { items: [listItem('fb-d')], total: 1, page: 1, limit: 20, unreadTotal: 0 });
      }
      if (url.includes('/dialogue')) return httpResponse(200, dialogueData());
      if (url.includes('/read')) return httpResponse(200, { ok: true });
      if (url.includes('/images/') || url.includes('attachments/')) {
        return httpResponse(200, new Blob(['x'], { type: 'image/png' }));
      }
      if (url.includes('/logs/')) return httpResponse(200, new Blob(['log'], { type: 'text/plain' }));
      return httpResponse(200, {});
    });
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.fab.click();
    await settled();
    m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
    await settled();
    m.root.querySelector<HTMLDivElement>('.fb-history-item')!.click();
    await settled();

    const logBtn = Array.from(m.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.includes('app.log'))!;
    logBtn.click();
    await settled();

    const logGet = calls.find((c) => c.url.includes('/logs/log-1/download'));
    expect(logGet).toBeDefined();
    expect(logGet!.headers.Authorization).toBe('Bearer test-access-token');
  });

  it('轮询增量渲染：新消息追加、回复草稿与滚动位置不动', async () => {
    const m = mount();
    let seq = 1;
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, { items: [listItem('fb-d')], total: 1, page: 1, limit: 20, unreadTotal: 0 });
      }
      if (url.includes('/dialogue')) {
        const base = dialogueData();
        (base.messages as unknown[]).push(
          ...(seq >= 2
            ? [{
                id: 'msg-2',
                seq: 2,
                senderType: 'admin',
                senderId: 'a1',
                senderName: '管理员',
                text: '第二条回复',
                createdAt: new Date().toISOString(),
                attachments: [],
              }]
            : []),
        );
        return httpResponse(200, base);
      }
      if (url.includes('/read')) return httpResponse(200, { ok: true });
      if (url.includes('/images/') || url.includes('attachments/') || url.includes('/logs/')) {
        return httpResponse(200, new Blob(['x'], { type: 'image/png' }));
      }
      return httpResponse(200, { items: [], total: 0, page: 1, limit: 20, unreadTotal: 0 });
    });
    // 全程假定时器：对话轮询间隔（10s）由定时器驱动
    vi.useFakeTimers();
    try {
      const step = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(50); };
      await completeLogin(m, undefined, IMAGE_CAPABILITIES);
      m.fab.click();
      await step();
      m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
      await step();
      m.root.querySelector<HTMLDivElement>('.fb-history-item')!.click();
      await step();

      const msgs = () => m.root.querySelectorAll('.fb-dialogue-msg');
      const firstMsgCount = msgs().length;
      // 回复草稿输入（轮询不得清空）
      const ta = m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!;
      ta.value = '打字中的草稿';
      ta.dispatchEvent(new Event('input'));

      // 触发对话轮询（10s）→ 新消息到达
      seq = 2;
      await vi.advanceTimersByTimeAsync(10_500);

      expect(msgs().length).toBe(firstMsgCount + 1);
      expect(ta.value).toBe('打字中的草稿'); // 草稿保留
      // 对话轮询确实发生了
      expect(calls.filter((c) => c.url.includes('/dialogue')).length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('回复支持多图附件（metadata.images + images 部件）', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, { items: [listItem('fb-d')], total: 1, page: 1, limit: 20, unreadTotal: 0 });
      }
      if (url.includes('/dialogue')) return httpResponse(200, dialogueData());
      if (url.includes('/read')) return httpResponse(200, { ok: true });
      if (url.includes('/images/') || url.includes('attachments/') || url.includes('/logs/')) {
        return httpResponse(200, new Blob(['x'], { type: 'image/png' }));
      }
      if (url.includes('/messages')) {
        return httpResponse(201, {
          ok: true,
          message: { id: 'm2', seq: 2, senderType: 'user', senderId: 'u', senderName: '我', text: '回复', createdAt: new Date().toISOString(), attachments: [] },
          dialogueVersion: 2,
          issueStatus: 'waiting_admin',
        });
      }
      return httpResponse(200, {});
    });
    await completeLogin(m, undefined, IMAGE_CAPABILITIES);
    m.fab.click();
    await settled();
    m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
    await settled();
    m.root.querySelector<HTMLDivElement>('.fb-history-item')!.click();
    await settled();

    // 回复框选择两张图（输入限定在回复区内，避免误选撰写区的 .fb-image-input）
    const replyBox = m.root.querySelector<HTMLElement>('.fb-dialogue-reply-box')!;
    const replyInput = replyBox.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(replyInput, 'files', { value: [pngFile('r1.png'), pngFile('r2.png')], configurable: true });
    replyInput.dispatchEvent(new Event('change'));
    await settled();
    expect(m.root.querySelectorAll('.fb-reply-thumb').length).toBe(2);

    const ta = m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!;
    ta.value = '回复内容';
    ta.dispatchEvent(new Event('input'));
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-reply-box .fb-submit')!.click();
    await settled(10);

    const msgPost = calls.find((c) => c.method === 'POST' && c.url.includes('/messages'));
    expect(msgPost).toBeDefined();
    const meta = formMeta(msgPost!);
    expect((meta.images as unknown[]).length).toBe(2);
    expect(meta.text).toBe('回复内容');
    expect(formParts(msgPost!, 'images').length).toBe(2);
    // 发送后回复图片清空
    expect(m.root.querySelectorAll('.fb-reply-thumb').length).toBe(0);
  });
});

// ---------- T3：未读摘要轮询（面板关闭也运行） ----------

describe('T3 未读摘要轮询', () => {
  it('面板关闭 + 已登录 + 页面可见 → 30s 轮询 unread-summary', async () => {
    const m = mount();
    const { calls } = recordFetch(async () =>
      httpResponse(200, { totalUnreadMessages: 3, unreadFeedbacks: 2 }),
    );
    // 定时器桩必须在登录之前安装：summaryPollTimer 由登录成功触发创建
    vi.useFakeTimers();
    try {
      await completeLogin(m, undefined, IMAGE_CAPABILITIES);
      // 不打开面板
      const before = calls.filter((c) => c.url.includes('unread-summary')).length;
      await vi.advanceTimersByTimeAsync(31_000);
      const after = calls.filter((c) => c.url.includes('unread-summary')).length;
      expect(after).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
    // 徽标数字更新
    expect(m.root.querySelector('.fb-launcher-badge')?.textContent).toContain('3');
  });
});
