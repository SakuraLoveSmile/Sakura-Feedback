/**
 * T4 诊断日志接入测试：FeedbackDiagnosticsRecorder（200 条 / 256KiB /
 * 白名单 / clear 世代清空）、wrapFetch（记录请求但不改全局 fetch）、
 * FeedbackErrorCapture（显式启用、保留宿主处理、可卸载），
 * 以及 recorder → widget.diagnosticsRecorder → logProvider 的闭环。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import '../src/index';
import {
  FeedbackDiagnosticsRecorder,
  FeedbackErrorCapture,
  wrapFetch,
} from '../src/diagnostics';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
} from './helpers';
import { stubCreateElementCanvas, createState } from './pixel-fixture';

async function settled(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5));
}

afterEach(cleanup);

describe('FeedbackDiagnosticsRecorder', () => {
  it('record 白名单字段：非白名单字段一律丢弃', () => {
    const rec = new FeedbackDiagnosticsRecorder({ pageLabel: 'checkout' });
    rec.record({
      event: 'custom',
      code: 'TypeError',
      status: 500,
      durationMs: 42.7,
      method: 'post',
      // 以下非白名单字段应被丢弃（类型层面不可传，运行时强制丢弃）
      ...({ url: 'https://x', message: 'secret', body: 'data' } as Record<string, unknown>),
    });
    const entry = JSON.parse(rec.toJsonl().trim()) as Record<string, unknown>;
    expect(entry.event).toBe('custom');
    expect(entry.code).toBe('TypeError');
    expect(entry.status).toBe(500);
    expect(entry.durationMs).toBe(43); // 四舍五入
    expect(entry.method).toBe('POST');
    expect(entry.pageLabel).toBe('checkout');
    expect(entry.url).toBeUndefined();
    expect(entry.message).toBeUndefined();
    expect(entry.body).toBeUndefined();
    expect(typeof entry.at).toBe('string');
  });

  it('条数上限：超过 maxEntries 丢弃最旧并计 dropped', () => {
    const rec = new FeedbackDiagnosticsRecorder({ maxEntries: 5 });
    for (let i = 0; i < 8; i++) rec.record({ event: `e${i}` });
    expect(rec.size).toBe(5);
    expect(rec.droppedCount).toBe(3);
    const lines = rec.toJsonl().trim().split('\n').map((l) => JSON.parse(l) as { event: string; status?: number });
    expect(lines[0]!.event).toBe('diagnostics_truncated');
    expect(lines[0]!.status).toBe(3);
    expect(lines[lines.length - 1]!.event).toBe('e7'); // 最旧的被丢
  });

  it('字节上限：超过 maxBytes 丢弃最旧', () => {
    const rec = new FeedbackDiagnosticsRecorder({ maxBytes: 2048, maxEntries: 10_000 });
    for (let i = 0; i < 200; i++) rec.record({ event: `evt-${i}`, code: 'x'.repeat(64) });
    expect(rec.size).toBeLessThan(200);
    expect(rec.droppedCount).toBeGreaterThan(0);
    expect(rec.toJsonl().length).toBeLessThanOrEqual(2048 + 128);
  });

  it('clear 清空缓冲（新世代不带走旧写入）', () => {
    const rec = new FeedbackDiagnosticsRecorder();
    rec.record({ event: 'a' });
    rec.record({ event: 'b' });
    expect(rec.size).toBe(2);
    rec.clear();
    expect(rec.size).toBe(0);
    expect(rec.toLogFile()).toBeNull();
  });

  it('toLogFile 产出 logProvider 兼容附件（.jsonl）', async () => {
    const rec = new FeedbackDiagnosticsRecorder();
    expect(rec.toLogFile()).toBeNull(); // 空缓冲不附加
    rec.record({ event: 'fetch', method: 'GET', status: 200 });
    const file = rec.toLogFile()!;
    expect(file.filename).toBe('feedback-diagnostics.jsonl');
    expect(file.blob.type).toBe('application/jsonl');
    const text = await file.blob.text();
    expect(text).toContain('"event":"fetch"');
  });
});

describe('wrapFetch', () => {
  it('记录 method/status/durationMs；不记录 URL；不替换全局 fetch', async () => {
    const rec = new FeedbackDiagnosticsRecorder();
    const globalFetch = globalThis.fetch;
    const wrapped = wrapFetch(rec, async () => httpResponse(201, { ok: true }) as unknown as Response);
    const res = await wrapped('https://secret.example/path?token=abc', { method: 'POST' });
    expect(res.status).toBe(201);
    expect(globalThis.fetch).toBe(globalFetch); // 全局未被替换

    expect(rec.size).toBe(1);
    const entry = JSON.parse(rec.toJsonl().trim()) as Record<string, unknown>;
    expect(entry.event).toBe('fetch');
    expect(entry.method).toBe('POST');
    expect(entry.status).toBe(201);
    expect(typeof entry.durationMs).toBe('number');
    // URL / token 不出现
    expect(rec.toJsonl()).not.toContain('secret.example');
    expect(rec.toJsonl()).not.toContain('token');
  });

  it('网络错误记录错误构造名并透传异常', async () => {
    const rec = new FeedbackDiagnosticsRecorder();
    const wrapped = wrapFetch(rec, async () => {
      throw new TypeError('network down');
    });
    await expect(wrapped('https://x')).rejects.toThrow('network down');
    const entry = JSON.parse(rec.toJsonl().trim()) as Record<string, unknown>;
    expect(entry.code).toBe('TypeError');
    expect(entry.status).toBeUndefined();
  });
});

describe('FeedbackErrorCapture', () => {
  it('install 后捕获 error/unhandledrejection（只记构造名），uninstall 停止', () => {
    const rec = new FeedbackDiagnosticsRecorder();
    const cap = new FeedbackErrorCapture(rec);
    expect(cap.active).toBe(false);
    cap.install();
    expect(cap.active).toBe(true);

    const hostHandler = vi.fn();
    window.addEventListener('error', hostHandler);
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('x'), message: 'boom' }));
    expect(hostHandler).toHaveBeenCalled(); // 宿主处理不受影响

    const entry = JSON.parse(rec.toJsonl().trim()) as Record<string, unknown>;
    expect(entry.event).toBe('error');
    expect(entry.code).toBe('RangeError');
    expect(entry.message).toBeUndefined(); // 不记 message

    cap.uninstall();
    expect(cap.active).toBe(false);
    window.removeEventListener('error', hostHandler);
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('y') }));
    expect(rec.size).toBe(1); // 不再记录
  });
});

describe('组件内接入（diagnosticsRecorder + logProvider）', () => {
  it('组件请求经 recorder 记录；logProvider 随提交附上诊断日志', async () => {
    const rec = new FeedbackDiagnosticsRecorder();
    stubCreateElementCanvas(createState());
    const m = mount();
    const { calls } = recordFetch(async () =>
      httpResponse(201, { feedbackId: 'fb-diag', status: 'received' }),
    );
    m.widget.diagnosticsRecorder = rec;
    m.widget.logProvider = async () => [rec.toLogFile()].filter((f): f is { filename: string; blob: Blob } => f !== null);
    await completeLogin(m, undefined, { dialogue: true, images: 5 });
    m.widget.open();
    await settled();
    setTextarea(m, '带诊断的提交');
    m.submitBtn.click();
    await settled(10);

    // 组件请求被记录（status=201 的 POST）
    const lines = rec.toJsonl().trim().split('\n').map((l) => JSON.parse(l) as { event: string; method?: string; status?: number });
    expect(lines.some((l) => l.event === 'fetch' && l.method === 'POST' && l.status === 201)).toBe(true);

    // multipart 里含诊断日志部件（文件名以 metadata.logs 描述符为准——
    // happy-dom 的 FormData.getAll 不保留第三参 filename 到返回对象上）
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/feedback'))!;
    const fd = post.rawBody as FormData;
    const logs = fd.getAll('logs') as Blob[];
    expect(logs.length).toBe(1);
    const meta = JSON.parse(String(fd.get('metadata'))) as { logs?: Array<{ filename: string }> };
    expect(meta.logs?.[0]?.filename).toBe('feedback-diagnostics.jsonl');
    const text = await logs[0]!.text();
    expect(text).toContain('"event":"fetch"');
  });
});
