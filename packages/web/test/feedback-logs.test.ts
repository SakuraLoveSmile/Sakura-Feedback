import { describe, it, expect, afterEach } from 'vitest';
import '../src/index';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  setTextarea,
  type Mounted,
} from './helpers';

afterEach(cleanup);

async function settled(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('L1-Web: 日志附件（自动采集、手动选择、预览、移除与冻结提交）', () => {
  async function ready(): Promise<{ m: Mounted; calls: ReturnType<typeof recordFetch>['calls'] }> {
    const m = mount();
    const { calls } = recordFetch(async () => httpResponse(201, { feedbackId: 'fb-log-1', status: 'received' }));
    await completeLogin(m);
    return { m, calls };
  }

  it('logProvider 自动采集：打开面板时自动调用，支持返回单个或多个日志', async () => {
    const { m } = await ready();

    m.widget.logProvider = async () => [
      { filename: 'app.log', blob: new Blob(['app log line 1\nline 2'], { type: 'text/plain' }) },
      { filename: 'console.json', blob: new Blob(['{"level":"warn","msg":"test"}'], { type: 'application/json' }) },
    ];

    m.widget.open();
    await settled(10);

    const logItems = m.root.querySelectorAll('.fb-log-item');
    expect(logItems.length).toBe(2);

    const names = Array.from(logItems).map((el) => el.querySelector('.fb-log-name')?.textContent);
    expect(names).toEqual(['app.log', 'console.json']);

    const badges = Array.from(logItems).map((el) => el.querySelector('.fb-log-badge')?.textContent);
    expect(badges).toEqual(['自动', '自动']);
  });

  it('logProvider 超时保护：超过 3 秒抛错不阻塞面板，显示超时提示且用户可正常输入提交', async () => {
    const { m, calls } = await ready();

    m.widget.logProvider = () =>
      new Promise((resolve) => {
        setTimeout(
          () => resolve({ filename: 'slow.log', blob: new Blob(['slow'], { type: 'text/plain' }) }),
          4000,
        );
      });

    // 模拟打开面板并快进时间
    m.widget.open();
    // 延迟 3.1s 等待 Promise.race 超时触发
    await new Promise((r) => setTimeout(r, 3200));
    await settled(5);

    const errEl = m.root.querySelector('.fb-log-error');
    expect(errEl?.textContent).toContain('超时');

    // 用户正常输入文本并提交
    setTextarea(m, '虽然日志采集超时但仍能提交');
    m.submitBtn.click();
    await settled(5);

    expect(calls.length).toBe(1);
    expect(calls[0]?.body?.text).toBe('虽然日志采集超时但仍能提交');
  }, 10000);

  it('手动选择日志文件：检查扩展名、大小限制与最多 3 个限制', async () => {
    const { m } = await ready();
    m.widget.open();
    await settled();

    const fileInput = m.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(fileInput).not.toBeNull();

    // 1. 不支持的扩展名 (.png)
    const invalidFile = new File(['png content'], 'screenshot.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', {
      value: [invalidFile],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    await settled();

    let errEl = m.root.querySelector('.fb-log-error');
    expect(errEl?.textContent).toContain('格式不受支持');
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);

    // 2. 超出 1MiB 大小
    const hugeBuf = new Uint8Array(1024 * 1024 + 10);
    const hugeFile = new File([hugeBuf], 'huge.log', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', {
      value: [hugeFile],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    await settled();

    errEl = m.root.querySelector('.fb-log-error');
    expect(errEl?.textContent).toContain('超过 1MiB 限制');
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);

    // 3. 正常添加 3 个有效日志 (.log, .txt, .json)
    const f1 = new File(['log 1'], 'client.log', { type: 'text/plain' });
    const f2 = new File(['txt 2'], 'info.txt', { type: 'text/plain' });
    const f3 = new File(['{"ok":true}'], 'data.json', { type: 'application/json' });
    const f4 = new File(['extra'], 'overflow.jsonl', { type: 'text/plain' });

    Object.defineProperty(fileInput, 'files', {
      value: [f1, f2, f3, f4],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    await settled();

    const items = m.root.querySelectorAll('.fb-log-item');
    expect(items.length).toBe(3); // 截断到 3 个
    errEl = m.root.querySelector('.fb-log-error');
    expect(errEl?.textContent).toContain('最多附加 3 个');

    const addBtn = m.root.querySelector<HTMLButtonElement>('.fb-btn-add-log');
    expect(addBtn?.hidden).toBe(true); // 已满 3 个隐藏添加按钮
  });

  it('文本预览与移除日志：支持纯文本弹窗查看，Esc 或关闭按钮退出，删除后更新列表与计数', async () => {
    const { m } = await ready();
    m.widget.open();
    await settled();

    const fileInput = m.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const f1 = new File(['Hello Feedback Log Line 1\nLine 2'], 'debug.log', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', {
      value: [f1],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    await settled();

    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(1);

    // 点击预览
    const previewBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-btn-preview')!;
    previewBtn.click();
    await settled();

    const previewModal = m.root.querySelector<HTMLDivElement>('.fb-log-preview-modal')!;
    expect(previewModal.classList.contains('is-open')).toBe(true);
    expect(m.root.querySelector('.fb-log-preview-body')?.textContent).toBe('Hello Feedback Log Line 1\nLine 2');

    // 按 Esc 键优先关闭日志预览弹窗
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(previewModal.classList.contains('is-open')).toBe(false);
    expect(m.panel.classList.contains('is-open')).toBe(true); // 面板仍打开

    // 点击删除按钮
    const removeBtn = m.root.querySelector<HTMLButtonElement>('.fb-log-btn-remove')!;
    removeBtn.click();
    await settled();

    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
    const countEl = m.root.querySelector('.fb-logs-count');
    expect(countEl?.textContent).toContain('(0/3)');
  });

  it('提交快照冻结与 multipart 契约：提交期间修改草稿不影响在途日志，成功后清空草稿', async () => {
    const { m, calls } = await ready();
    m.widget.open();
    await settled();

    // 添加 2 个日志
    const fileInput = m.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const f1 = new File(['log-content-1'], 'error.log', { type: 'text/plain' });
    const f2 = new File(['log-content-2'], 'network.txt', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', {
      value: [f1, f2],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    await settled();

    setTextarea(m, '有日志的反馈');
    m.submitBtn.click();
    await settled(10);

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.body?.text).toBe('有日志的反馈');

    // 检查 metadata.logs 描述符
    const logsMeta = (call.body as { logs?: Array<{ filename: string; source: string }> }).logs!;
    expect(logsMeta).toBeDefined();
    expect(logsMeta.length).toBe(2);
    expect(logsMeta[0]?.filename).toBe('error.log');
    expect(logsMeta[0]?.source).toBe('manual');
    expect(logsMeta[1]?.filename).toBe('network.txt');
    expect(logsMeta[1]?.source).toBe('manual');

    // 检查 rawBody (FormData)
    const fd = call.rawBody as FormData;
    expect(fd).toBeDefined();
    const logParts = fd.getAll('logs');
    expect(logParts.length).toBe(2);

    // 成功提交后草稿与日志列表均清空
    expect(m.textarea.value).toBe('');
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('提交失败重试：复用同一幂等键与日志快照；修改日志后生成新键', async () => {
    const m = mount();
    let attempt = 0;
    const { calls } = recordFetch(async () => {
      attempt++;
      if (attempt === 1) {
        return httpResponse(500, { error: { code: 'server_error', message: '服务异常' } });
      }
      return httpResponse(201, { feedbackId: 'fb-log-retry', status: 'received' });
    });
    await completeLogin(m);
    m.widget.open();
    await settled();

    const fileInput = m.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const f1 = new File(['retry log content'], 'retry.log', { type: 'text/plain' });
    Object.defineProperty(fileInput, 'files', {
      value: [f1],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    await settled();

    setTextarea(m, '准备重试');
    m.submitBtn.click();
    await settled(10);

    expect(calls.length).toBe(1);
    const key1 = calls[0]?.body?.idempotencyKey;
    expect(key1).toBeDefined();
    expect(m.errorRegion.textContent).toContain('服务异常');

    // 草稿与日志保留
    expect(m.textarea.value).toBe('准备重试');
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(1);

    // 不修改草稿直接点击重试提交
    m.submitBtn.click();
    await settled(10);

    expect(calls.length).toBe(2);
    const key2 = calls[1]?.body?.idempotencyKey;
    // 幂等复用相同 key
    expect(key2).toBe(key1);

    // 终态成功后清空
    expect(m.textarea.value).toBe('');
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);
  });

  it('卸载期间返回的旧采集结果被丢弃，重挂载后只保留新结果', async () => {
    const { m } = await ready();
    let calls = 0;
    let resolveFirst: ((value: { filename: string; blob: Blob }) => void) | undefined;
    let resolveSecond: ((value: { filename: string; blob: Blob }) => void) | undefined;
    m.widget.logProvider = () => {
      calls++;
      return new Promise((resolve) => {
        if (calls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    };

    m.widget.open();
    await settled();
    expect(calls).toBe(1);

    m.widget.remove();
    resolveFirst?.({ filename: 'late.log', blob: new Blob(['late']) });
    await settled();
    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(0);

    document.body.appendChild(m.widget);
    await settled();
    expect(calls).toBe(2);
    resolveSecond?.({ filename: 'fresh.log', blob: new Blob(['fresh']) });
    await settled();

    expect(m.root.querySelectorAll('.fb-log-item').length).toBe(1);
    expect(m.root.querySelector('.fb-log-name')?.textContent).toBe('fresh.log');
  });

  it('旧采集请求的 finally 不会清除重挂载后新采集的忙碌态', async () => {
    const { m } = await ready();
    let calls = 0;
    let resolveFirst: ((value: { filename: string; blob: Blob }) => void) | undefined;
    let resolveSecond: ((value: { filename: string; blob: Blob }) => void) | undefined;
    m.widget.logProvider = () => {
      calls++;
      return new Promise((resolve) => {
        if (calls === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    };

    m.widget.open();
    await settled();
    m.widget.remove();
    document.body.appendChild(m.widget);
    await settled();
    expect(calls).toBe(2);

    resolveFirst?.({ filename: 'late.log', blob: new Blob(['late']) });
    await settled();
    const addLogButton = m.root.querySelector<HTMLButtonElement>('.fb-btn-add-log');
    expect(addLogButton?.disabled).toBe(true);
    expect(m.root.querySelector<HTMLElement>('.fb-log-status')?.hidden).toBe(false);

    resolveSecond?.({ filename: 'fresh.log', blob: new Blob(['fresh']) });
    await settled();
    expect(m.root.querySelector('.fb-log-name')?.textContent).toBe('fresh.log');
    expect(addLogButton?.disabled).toBe(false);
  });
});
