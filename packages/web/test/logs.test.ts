/**
 * T1「打开反馈面板自动带上最近日志，也能手动补充」回归测试
 * （docs/logs-plan.md §4）：
 * - 采集时机（新草稿首次打开一次 / 重新打开不采集 / 有草稿不采集 / 移除后不补回）；
 * - 超时（3 秒）与失败的重试、不带日志继续提交，且不阻塞截图与描述提交；
 * - 上限（3 个 / 1 MiB / 扩展名白名单 / 严格 UTF-8）与明确提示，不静默丢弃；
 * - 面板：文件名 / 大小 / 来源、纯文本预览（截断并说明）、移除；
 * - 迟到结果（关闭 / 卸载 / 切换 api-base|app-id / 提交冻结）不写回；
 * - 提交编码：multipart 下 metadata.logs 与 logs 部件同序、byteSize、filename、type；
 *   修改附件后新幂等键；无日志无截图仍走原 JSON 且字段逐字节不变。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import '../src/index';
import { openFeedback, type FeedbackLogFile, type LogProvider } from '../src/index';
import {
  API_BASE,
  apiError,
  cleanup,
  completeLogin,
  httpResponse,
  logFile,
  logItems,
  mount,
  pickLogFiles,
  recordFetch,
  setTextarea,
  stubWindowOpen,
} from './helpers';

afterEach(cleanup);

async function settled(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function textOf(part: Blob): Promise<string> {
  return new TextDecoder().decode(await part.arrayBuffer());
}

function logParts(form: FormData): Blob[] {
  return form.getAll('logs') as Blob[];
}

describe('日志：自动采集时机', () => {
  it('未配置 logProvider：只显示「手动添加日志」入口，并说明会参与 AI 分析并归档', () => {
    const m = mount();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logList.hidden).toBe(true);
    expect(m.logAddLabel.textContent).toContain('添加日志');
    expect(m.logPreview.hidden).toBe(true);
    expect(m.logStatusLine.hidden).toBe(true);
    expect(m.logArea.textContent).toContain('日志会参与 AI 分析并随反馈归档');
    // 手动入口就是契约要求的原生 input
    expect(m.logInput.type).toBe('file');
    expect(m.logInput.multiple).toBe(true);
    expect(m.logInput.accept).toBe('.log,.txt,.json,.jsonl');
    expect(m.logInput.disabled).toBe(false);
  });

  it('新草稿首次打开采集一次（文件名 / 大小 / 来源）；重新打开已有草稿不重新采集', async () => {
    const m = mount();
    const provider = vi.fn(() => logFile('app.log', 'hello world'));
    m.widget.logProvider = provider;

    m.widget.open();
    await settled();
    expect(provider).toHaveBeenCalledTimes(1);
    const items = logItems(m);
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain('app.log');
    expect(items[0]?.textContent).toContain('11 B');
    expect(items[0]?.textContent).toContain('自动');

    // 关闭重开：草稿（含日志列表）保留，**不重新采集**
    m.widget.close();
    m.widget.open();
    await settled();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(logItems(m)).toHaveLength(1);
  });

  it('已有文字草稿时打开不采集（恢复草稿语义）', async () => {
    const m = mount();
    const provider = vi.fn(() => logFile('app.log', 'x'));
    m.widget.logProvider = provider;
    setTextarea(m, '先写下的草稿');
    m.widget.open();
    await settled();
    expect(provider).not.toHaveBeenCalled();
    expect(logItems(m)).toHaveLength(0);
  });

  it('用户移除后不自动补回', async () => {
    const m = mount();
    const provider = vi.fn(() => logFile('app.log', 'x'));
    m.widget.logProvider = provider;
    m.widget.open();
    await settled();
    expect(logItems(m)).toHaveLength(1);

    m.logList.querySelector<HTMLButtonElement>('.fb-log-remove-btn')?.click();
    expect(logItems(m)).toHaveLength(0);

    m.widget.close();
    m.widget.open();
    await settled();
    expect(provider).toHaveBeenCalledTimes(1); // 不自动补回
    expect(logItems(m)).toHaveLength(0);
  });

  it('openFeedback({ logProvider }) 同样生效：创建元素并首次打开即采集', async () => {
    const widget = openFeedback({
      apiBase: API_BASE,
      appId: 'com.example.openfeedback',
      logProvider: () => logFile('of.log', 'via-openFeedback'),
    });
    await settled();
    const root = widget.shadowRoot as ShadowRoot;
    expect(root.querySelectorAll('.fb-log-item')).toHaveLength(1);
    expect(root.querySelector('.fb-log-name')?.textContent).toBe('of.log');
    expect(root.querySelector('.fb-log-meta')?.textContent).toContain('自动');
  });

  it('回调返回 null / 空数组：按「本次没有日志」处理，不报错', async () => {
    const m = mount();
    m.widget.logProvider = () => null;
    m.widget.open();
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.hidden).toBe(true);

    m.widget.logProvider = () => [];
    m.widget.close();
    m.widget.open();
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.hidden).toBe(true);
  });

  it('回调返回结构不合法：明确提示「日志获取失败」并给出重试入口', async () => {
    const m = mount();
    m.widget.logProvider = (() => ({ name: 'app.log', bytes: 'not-bytes' })) as unknown as LogProvider;
    m.widget.open();
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.textContent).toContain('日志获取失败');
    expect(m.logStatusLine.textContent).toContain('格式不正确');
    expect(m.logRetryBtn.hidden).toBe(false);
    expect(m.logSkipBtn.hidden).toBe(false);
  });

  it('自动采集到超限文件：明确提示、不静默丢弃、不截断字节', async () => {
    const m = mount();
    m.widget.logProvider = () => [
      logFile('a.log', 'a'),
      logFile('b.log', 'bb'),
      logFile('c.log', 'ccc'),
      logFile('d.log', 'dddd'),
    ];
    m.widget.open();
    await settled();
    const items = logItems(m);
    expect(items).toHaveLength(3);
    expect(m.logStatusLine.textContent).toContain('最多只能附加 3 个');
    expect(m.logStatusLine.textContent).toContain('d.log');
    // 前三个按原字节保留（大小而不是被截断后的长度）
    expect(items[2]?.textContent).toContain('3 B');
  });

  it('自动采集到单个超限文件：整批拒绝并给出明确原因（按失败处理）', async () => {
    const m = mount();
    m.widget.logProvider = () => logFile('huge.log', 'x'.repeat(1024 * 1024 + 1));
    m.widget.open();
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.textContent).toContain('日志获取失败');
    expect(m.logStatusLine.textContent).toContain('超过');
    expect(m.logStatusLine.textContent).toContain('huge.log');
  });
});

describe('日志：超时与失败不阻塞提交', () => {
  it('3 秒超时 → 「日志获取失败」+ 重试 / 不带日志继续提交，描述仍可提交', async () => {
    vi.useFakeTimers();
    try {
      const m = mount();
      m.widget.logProvider = () => new Promise<FeedbackLogFile | null>(() => {});
      m.widget.open();
      await vi.advanceTimersByTimeAsync(0);
      expect(m.logStatusLine.textContent).toContain('正在获取日志');

      await vi.advanceTimersByTimeAsync(3000);
      expect(m.logStatusLine.textContent).toContain('日志获取失败');
      expect(m.logStatusLine.textContent).toContain('超过 3 秒');
      expect(m.logRetryBtn.hidden).toBe(false);
      expect(m.logSkipBtn.hidden).toBe(false);

      // 失败 / 超时不阻塞描述：有内容即可提交
      setTextarea(m, '超时也照样提交');
      expect(m.submitBtn.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('失败后「重试」成功：日志进入草稿、失败态清除', async () => {
    const m = mount();
    let attempt = 0;
    m.widget.logProvider = () => {
      attempt++;
      if (attempt === 1) return Promise.reject(new Error('宿主导出失败'));
      return logFile('retry.log', 'ok');
    };
    m.widget.open();
    await settled();
    expect(m.logStatusLine.textContent).toContain('日志获取失败');
    expect(m.logStatusLine.textContent).toContain('宿主导出失败');

    m.logRetryBtn.click();
    await settled();
    expect(attempt).toBe(2);
    expect(logItems(m)).toHaveLength(1);
    expect(m.logList.querySelector('.fb-log-name')?.textContent).toBe('retry.log');
    expect(m.logStatusLine.hidden).toBe(true);
    expect(m.logRetryBtn.hidden).toBe(true);
  });

  it('「不带日志继续提交」：清掉失败态并走原 JSON 提交', async () => {
    stubWindowOpen({ closed: false });
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb-no-logs', status: 'received' }));
    completeLogin(m);
    m.widget.logProvider = () => Promise.reject(new Error('boom'));
    m.widget.open();
    await settled();
    expect(m.logStatusLine.textContent).toContain('日志获取失败');

    setTextarea(m, '没有日志也要提交');
    m.logSkipBtn.click();
    await settled();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_BASE}/api/feedback`);
    expect(calls[0]?.body?.text).toBe('没有日志也要提交');
    expect(calls[0]?.body?.logs).toBeUndefined();
    expect(m.statusRegion.textContent).toContain('已保存，正在整理');
  });
});

describe('日志：手动添加与上限', () => {
  it('手动添加多个文件：按字节读取、来源「手动」、人类可读大小', async () => {
    const m = mount();
    pickLogFiles(m, [new File(['a'.repeat(1024)], 'first.log'), new File(['{"a":1}'], 'second.json')]);
    await settled();
    const items = logItems(m);
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('first.log');
    expect(items[0]?.textContent).toContain('1.0 KiB');
    expect(items[0]?.textContent).toContain('手动');
    expect(items[1]?.textContent).toContain('second.json');
    expect(items[1]?.textContent).toContain('7 B');
    expect(m.logList.hidden).toBe(false);
  });

  it('扩展名 / 空文件 / 超大 / 非 UTF-8 / 二进制：逐个明确提示且不加入列表', async () => {
    const m = mount();

    pickLogFiles(m, [new File(['data'], 'notes.csv')]);
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.textContent).toContain('不支持的文件类型');

    pickLogFiles(m, [new File([], 'empty.log')]);
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.textContent).toContain('文件为空');

    pickLogFiles(m, [new File([new Uint8Array(1024 * 1024 + 1)], 'big.log')]);
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.textContent).toContain('超过');
    expect(m.logStatusLine.textContent).toContain('big.log');

    pickLogFiles(m, [new File([new Uint8Array([0xff, 0xfe, 0xfd])], 'binary.log')]);
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.textContent).toContain('UTF-8');

    // 合法 UTF-8（含中文与 NUL 之外的控制字符）可以附加
    pickLogFiles(m, [new File(['中文日志\nline2'], 'ok.txt')]);
    await settled();
    expect(logItems(m)).toHaveLength(1);
    expect(m.logStatusLine.hidden).toBe(true);
  });

  it('自动与手动共用同一上限（3 个）', async () => {
    const m = mount();
    m.widget.logProvider = () => [logFile('auto1.log', '1'), logFile('auto2.log', '22')];
    m.widget.open();
    await settled();
    expect(logItems(m)).toHaveLength(2);

    pickLogFiles(m, [new File(['m1'], 'm1.log'), new File(['m2'], 'm2.log')]);
    await settled();
    const items = logItems(m);
    expect(items).toHaveLength(3);
    expect(items[2]?.textContent).toContain('m1.log');
    expect(m.logStatusLine.textContent).toContain('最多只能附加 3 个');
    expect(m.logStatusLine.textContent).toContain('m2.log');
  });

  it('纯文本预览：按上限截断并说明；可收起；可移除', async () => {
    const m = mount();
    pickLogFiles(m, [new File(['x'.repeat(5000)], 'long.log')]);
    await settled();
    expect(m.logPreview.hidden).toBe(true);

    m.logList.querySelector<HTMLButtonElement>('.fb-log-preview-btn')?.click();
    expect(m.logPreview.hidden).toBe(false);
    const preview = m.logPreview.textContent ?? '';
    expect(preview).toContain('已截断');
    expect(preview).toContain('共 5000 个字符');
    expect(preview.startsWith('x'.repeat(100))).toBe(true);
    expect(preview.length).toBeLessThan(5000);

    m.logList.querySelector<HTMLButtonElement>('.fb-log-preview-btn')?.click();
    expect(m.logPreview.hidden).toBe(true);

    // 关闭面板即收起预览（DOM 与状态保持一致）
    m.logList.querySelector<HTMLButtonElement>('.fb-log-preview-btn')?.click();
    expect(m.logPreview.hidden).toBe(false);
    m.widget.close();
    expect(m.logPreview.hidden).toBe(true);

    m.logList.querySelector<HTMLButtonElement>('.fb-log-remove-btn')?.click();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logList.hidden).toBe(true);
    expect(m.logPreview.hidden).toBe(true);
  });
});

describe('日志：迟到结果不写回', () => {
  it('关闭面板后迟到的采集结果不写回；重开给出明确中断提示与重试', async () => {
    const m = mount();
    const d = deferred<FeedbackLogFile | null>();
    m.widget.logProvider = () => d.promise;
    m.widget.open();
    await settled();
    expect(m.logStatusLine.textContent).toContain('正在获取日志');

    m.widget.close();
    d.resolve(logFile('late.log', 'late'));
    await settled();
    expect(logItems(m)).toHaveLength(0);

    m.widget.open();
    await settled();
    expect(logItems(m)).toHaveLength(0);
    expect(m.logStatusLine.textContent).toContain('日志获取失败');
    expect(m.logRetryBtn.hidden).toBe(false);
  });

  it('元素卸载后迟到的采集结果不写回', async () => {
    const m = mount();
    const d = deferred<FeedbackLogFile | null>();
    m.widget.logProvider = () => d.promise;
    m.widget.open();
    await settled();

    m.widget.remove();
    d.resolve(logFile('late.log', 'late'));
    await settled();
    document.body.appendChild(m.widget);
    expect(logItems(m)).toHaveLength(0);
  });

  it('切换 api-base / app-id 后迟到的采集结果不写回', async () => {
    const a = mount();
    const d1 = deferred<FeedbackLogFile | null>();
    a.widget.logProvider = () => d1.promise;
    a.widget.open();
    await settled();
    a.widget.setAttribute('api-base', 'http://other.test:9999');
    d1.resolve(logFile('late.log', 'late'));
    await settled();
    expect(logItems(a)).toHaveLength(0);

    const b = mount();
    const d2 = deferred<FeedbackLogFile | null>();
    b.widget.logProvider = () => d2.promise;
    b.widget.open();
    await settled();
    b.widget.setAttribute('app-id', 'com.other.app');
    d2.resolve(logFile('late.log', 'late'));
    await settled();
    expect(logItems(b)).toHaveLength(0);
  });

  it('提交 / 轮询期间锁定附件修改；冻结快照不受迟到采集结果影响', async () => {
    stubWindowOpen({ closed: false });
    const m = mount();
    const d = deferred<FeedbackLogFile | null>();
    m.widget.logProvider = () => d.promise;
    const submitDeferred = deferred<unknown>();
    let submitted: FormData | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      submitted = (init?.body as FormData) ?? null;
      return submitDeferred.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    completeLogin(m);

    m.widget.open();
    await settled();
    // 采集中追加一条手动日志（共用上限），随后提交
    pickLogFiles(m, [new File(['manual'], 'm.log')]);
    await settled();
    setTextarea(m, '锁定期提交');
    m.submitBtn.click();
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.logInput.disabled).toBe(true);
    const removeBtn = m.logList.querySelector<HTMLButtonElement>('.fb-log-remove-btn');
    expect(removeBtn?.disabled).toBe(true);
    removeBtn?.click(); // 锁定期间移除无效
    expect(logItems(m)).toHaveLength(1);
    // 也挡掉程序化追加
    pickLogFiles(m, [new File(['sneak'], 'sneak.log')]);
    await settled();
    expect(logItems(m)).toHaveLength(1);

    // 冻结后迟到的采集结果不得写回，也不得进入本次请求
    d.resolve(logFile('late.log', 'late'));
    await settled();
    expect(logItems(m)).toHaveLength(1);
    const frozen = submitted as unknown as FormData;
    const meta = JSON.parse(String(frozen.get('metadata')));
    expect(meta.logs).toHaveLength(1);
    expect(meta.logs[0].name).toBe('m.log');

    submitDeferred.resolve(httpResponse(201, { feedbackId: 'fb-lock', status: 'received' }));
    await settled();
    // 轮询期间附件同样锁定
    expect(m.logInput.disabled).toBe(true);
  });
});

describe('日志：提交编码与幂等', () => {
  it('有日志时走 multipart：metadata.logs 与 logs 部件同序、byteSize 与实际字节一致', async () => {
    const m = mount();
    m.widget.logProvider = () => [logFile('app.log', 'auto-line'), logFile('net.jsonl', '{"a":1}')];
    m.widget.open();
    await settled();
    pickLogFiles(m, [new File(['manual-bytes'], 'manual.txt')]);
    await settled();

    let form: FormData | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      form = (init?.body as FormData) ?? null;
      return httpResponse(201, { feedbackId: 'fb-logs', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    completeLogin(m);
    setTextarea(m, '带日志的反馈');
    m.submitBtn.click();
    await settled();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(form).toBeInstanceOf(FormData);
    const body = form as unknown as FormData;
    const meta = JSON.parse(String(body.get('metadata')));
    expect(meta.logs).toEqual([
      { name: 'app.log', source: 'auto', byteSize: 9 },
      { name: 'net.jsonl', source: 'auto', byteSize: 7 },
      { name: 'manual.txt', source: 'manual', byteSize: 12 },
    ]);
    // 部件顺序与 metadata.logs 一一对应；filename 用日志文件名，type 为 text/plain
    const parts = logParts(body);
    expect(parts.map((p) => p.type)).toEqual(['text/plain', 'text/plain', 'text/plain']);
    expect(parts.map((p) => (p as File).name)).toEqual(['app.log', 'net.jsonl', 'manual.txt']);
    const texts = await Promise.all(parts.map((p) => textOf(p)));
    expect(texts).toEqual(['auto-line', '{"a":1}', 'manual-bytes']);
  });

  it('截图 + 日志：同一次 multipart 携带 screenshot 与同序 logs', async () => {
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => 'blob:mock');
    } else {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    }
    if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();

    const m = mount();
    m.widget.logProvider = () => logFile('shot.log', 'with-shot');
    m.widget.captureProvider = vi.fn(async () => ({
      blob: new Blob(['png-bytes'], { type: 'image/png' }),
      width: 100,
      height: 100,
    }));

    let form: FormData | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      form = (init?.body as FormData) ?? null;
      return httpResponse(201, { feedbackId: 'fb-both', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    completeLogin(m);

    await m.widget.captureAndOpen();
    await settled();
    expect(logItems(m)).toHaveLength(1);

    setTextarea(m, '截图与日志');
    m.submitBtn.click();
    await settled();

    const body = form as unknown as FormData;
    expect(body.has('screenshot')).toBe(true);
    const meta = JSON.parse(String(body.get('metadata')));
    expect(meta.capture).toBeTruthy();
    expect(meta.logs).toEqual([{ name: 'shot.log', source: 'auto', byteSize: 9 }]);
    expect((logParts(body)[0] as File).name).toBe('shot.log');
    expect(await textOf(logParts(body)[0] as Blob)).toBe('with-shot');
  });

  it('修改附件后生成新的幂等键；附件未变时重试复用同一幂等键与同一字节', async () => {
    stubWindowOpen({ closed: false });
    const m = mount();
    const metas: string[] = [];
    // 三次都失败：草稿（含日志）保留，提交失败保留原快照
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      const body = init?.body as FormData;
      metas.push(String(body.get('metadata')));
      return httpResponse(500, apiError(500, 'server_error', 'boom'));
    });
    vi.stubGlobal('fetch', fetchMock);
    completeLogin(m);

    m.widget.logProvider = () => logFile('app.log', 'first');
    m.widget.open();
    await settled();
    setTextarea(m, '幂等键与附件');
    m.submitBtn.click();
    await settled();
    expect(metas).toHaveLength(1);

    // 附件未变：重试复用同一幂等键与同一字节
    m.submitBtn.click();
    await settled();
    expect(metas).toHaveLength(2);
    expect(metas[1]).toBe(metas[0]);

    // 提交失败保留原快照与全部附件
    expect(logItems(m)).toHaveLength(1);
    expect(m.textarea.value).toBe('幂等键与附件');

    // 修改附件（新增日志）→ 新快照 → 新幂等键
    pickLogFiles(m, [new File(['extra'], 'extra.log')]);
    await settled();
    m.submitBtn.click();
    await settled();
    expect(metas).toHaveLength(3);
    const before = JSON.parse(metas[0] as string);
    const after = JSON.parse(metas[2] as string);
    expect(after.idempotencyKey).not.toBe(before.idempotencyKey);
    expect(after.logs).toHaveLength(2);
    expect(before.logs).toHaveLength(1);

    // 失败后草稿（含日志）仍在
    expect(logItems(m)).toHaveLength(2);
  });

  it('没有日志也没有截图：仍走原 JSON 请求，字段与历史完全一致', async () => {
    const m = mount();
    const metabodies: unknown[] = [];
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      metabodies.push(init?.body);
      return httpResponse(201, { feedbackId: 'fb-json', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    completeLogin(m);
    setTextarea(m, '纯文字反馈');
    m.submitBtn.click();
    await settled();

    expect(metabodies[0]).not.toBeInstanceOf(FormData);
    expect(typeof metabodies[0]).toBe('string');
    const body = JSON.parse(String(metabodies[0]));
    expect(Object.keys(body)).toEqual(['idempotencyKey', 'appId', 'text', 'context']);
    expect(body.appId).toBe('com.example.app');
    expect(body.text).toBe('纯文字反馈');
    expect(body.context).toEqual({ appVersion: '1.2.3', pageLabel: 'settings/account' });
    expect(body.logs).toBeUndefined();
  });

  it('有日志无截图同样走 multipart（logs 部件 0..3 个重复同名部件）', async () => {
    const m = mount();
    let form: FormData | null = null;
    const fetchMock = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      form = (init?.body as FormData) ?? null;
      return httpResponse(201, { feedbackId: 'fb-log-only', status: 'received' });
    });
    vi.stubGlobal('fetch', fetchMock);
    completeLogin(m);
    pickLogFiles(m, [new File(['only-log'], 'only.log')]);
    await settled();
    setTextarea(m, '只有日志');
    m.submitBtn.click();
    await settled();

    const body = form as unknown as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.has('screenshot')).toBe(false);
    expect(body.getAll('logs')).toHaveLength(1);
    expect(JSON.parse(String(body.get('metadata'))).logs).toEqual([
      { name: 'only.log', source: 'manual', byteSize: 8 },
    ]);
  });
});
