/**
 * v0.8.2「一键已读」：`POST /api/feedback/read-all` 的组件行为验收。
 *
 * 硬绑定锚点（不得改名/换序，e2e 依赖）：`.fb-history-filter` → `.fb-history-refresh` →
 * `.fb-history-read-all` 依次位于 `.fb-history-filter-row` 内；提示节点为
 * `.fb-history-read-hint[role=status]`（默认 hidden，成功/失败时显示）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import '../src/index';
import { STYLES } from '../src/styles';
import {
  API_BASE,
  APP_ID,
  TEST_TOKEN,
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  type Mounted,
} from './helpers';

afterEach(cleanup);

async function settled(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fb-aaaa1111bbbb',
    appId: APP_ID,
    appName: '示例应用',
    title: '登录页白屏',
    text: '点开登录就白屏',
    issueStatus: 'open',
    lastActivityAt: '2026-10-12T09:00:00.000Z',
    createdAt: '2026-10-11T09:00:00.000Z',
    unread: true,
    messageCount: 3,
    imageCount: 0,
    logCount: 0,
    latestMessage: null,
    ...over,
  };
}

function listResponse(items: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    items,
    total: (extra.total as number) ?? items.length,
    page: 1,
    limit: 20,
    unreadTotal: 0,
    ...extra,
  };
}

/** 打开面板并切到「我的反馈」。 */
async function toHistory(m: Mounted): Promise<void> {
  m.fab.click();
  await settled();
  m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
  await settled();
}

const readAllBtn = (m: Mounted): HTMLButtonElement =>
  m.root.querySelector<HTMLButtonElement>('.fb-history-read-all')!;
const readHint = (m: Mounted): HTMLParagraphElement =>
  m.root.querySelector<HTMLParagraphElement>('.fb-history-read-hint')!;

describe('入口与结构', () => {
  it('过滤行末尾追加「一键已读」：既有筛选/刷新锚点顺序不变，按钮语义完整', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([item()], { unreadTotal: 2 }))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const row = m.root.querySelector<HTMLElement>('.fb-history-filter-row')!;
    expect(row).not.toBeNull();
    // 既有 e2e 硬绑定：select(.fb-history-filter) → 刷新(.fb-history-refresh) → 一键已读
    const order = Array.from(row.children).map((child) => {
      if (child.classList.contains('fb-history-filter')) return 'filter';
      if (child.classList.contains('fb-history-refresh')) return 'refresh';
      if (child.classList.contains('fb-history-read-all')) return 'readAll';
      return 'other';
    });
    expect(order).toEqual(['filter', 'refresh', 'readAll']);

    const btn = readAllBtn(m);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    expect(btn.textContent).toBe('一键已读');
    expect(btn.className).toBe('fb-btn-secondary fb-history-read-all');
    expect(btn.getAttribute('aria-label')).toBe('将全部未读反馈标记为已读');
    // unreadTotal = 2 → 可点
    expect(btn.disabled).toBe(false);
    // 提示节点默认隐藏，读屏可播报
    expect(readHint(m).getAttribute('role')).toBe('status');
    expect(readHint(m).hidden).toBe(true);
    // 440px 面板内允许换行，避免第三个按钮把过滤行撑出横向溢出
    expect(STYLES).toMatch(/\.fb-history-filter-row \{[^}]*flex-wrap: wrap/);
  });

  it('列表 unreadTotal = 0 时按钮禁用（无可标记的未读）', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([item({ unread: false })], { unreadTotal: 0 }))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    expect(readAllBtn(m).disabled).toBe(true);
    expect(readAllBtn(m).textContent).toBe('一键已读');
  });

  it('未登录进入我的反馈（登录提示）时不渲染一键已读按钮', async () => {
    const m = mount();
    m.fab.click();
    await settled();
    m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
    await settled();
    expect(m.root.querySelector('.fb-history-read-all')).toBeNull();
    expect(m.root.querySelector('.fb-history-read-hint')).toBeNull();
  });
});

describe('请求与成功路径', () => {
  it('点击发出 POST read-all（appId 查询参数 + Bearer），成功后显示 role=status 提示并刷新列表', async () => {
    let listReads = 0;
    const m = mount();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/read-all')) {
        return httpResponse(200, { ok: true, markedFeedbacks: 1, markedMessages: 1 });
      }
      if (url.includes('/api/feedback/mine')) {
        listReads += 1;
        // 首次：1 条未读；一键已读后：未读清零
        return httpResponse(
          200,
          listResponse([item({ unread: listReads === 1 })], { unreadTotal: listReads === 1 ? 1 : 0 }),
        );
      }
      if (url.includes('unread-summary')) {
        return httpResponse(200, { unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    await toHistory(m);
    const before = listReads;
    readAllBtn(m).click();
    await settled(20);

    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/feedback/read-all'));
    expect(post, '必须发出 POST /api/feedback/read-all').toBeDefined();
    expect(post!.url).toBe(`${API_BASE}/api/feedback/read-all?appId=${encodeURIComponent(APP_ID)}`);
    expect(post!.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    // 成功后重新拉取列表（未读标签与 unreadTotal 一并刷新）
    expect(listReads).toBe(before + 1);

    const hint = readHint(m);
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('已全部标记为已读');
    expect(hint.classList.contains('is-error')).toBe(false);
    // 未读已清零 → 按钮禁用
    expect(readAllBtn(m).disabled).toBe(true);
  });

  it('未锁定 app-id 时不追加 appId 查询参数（按账号全部项目处理）', async () => {
    const m = mount({ 'app-id': '' });
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/api/feedback/read-all')) {
        return httpResponse(200, { ok: true, markedFeedbacks: 0, markedMessages: 0 });
      }
      if (url.includes('/api/feedback/mine')) return httpResponse(200, listResponse([item()], { unreadTotal: 1 }));
      return httpResponse(200, {});
    });
    m.widget.adoptSession({
      accessToken: TEST_TOKEN,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    await settled();
    await toHistory(m);

    readAllBtn(m).click();
    await settled(20);
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/feedback/read-all'));
    expect(post, '必须发出 POST /api/feedback/read-all').toBeDefined();
    expect(post!.url).toBe(`${API_BASE}/api/feedback/read-all`);
  });

  it('请求中按钮 disabled 且文案为「标记中…」，完成后恢复', async () => {
    let resolveReadAll!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolveReadAll = resolve;
    });
    const m = mount();
    recordFetch(async (url) => {
      if (url.includes('/api/feedback/read-all')) return pending;
      if (url.includes('/api/feedback/mine')) return httpResponse(200, listResponse([item()], { unreadTotal: 1 }));
      if (url.includes('unread-summary')) {
        return httpResponse(200, { unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    await toHistory(m);

    readAllBtn(m).click();
    expect(readAllBtn(m).disabled).toBe(true);
    expect(readAllBtn(m).textContent).toBe('标记中…');

    resolveReadAll(httpResponse(200, { ok: true, markedFeedbacks: 1, markedMessages: 2 }));
    await settled(20);
    expect(readHint(m).textContent).toBe('已全部标记为已读');
  });
});

describe('失败与过期响应', () => {
  it('失败显示「标记失败：<原因>，请重试」并恢复按钮，可再次点击重试成功', async () => {
    let readAllCalls = 0;
    const m = mount();
    recordFetch(async (url) => {
      if (url.includes('/api/feedback/read-all')) {
        readAllCalls += 1;
        return readAllCalls === 1
          ? httpResponse(500, { error: { code: 'internal', message: 'boom' } })
          : httpResponse(200, { ok: true, markedFeedbacks: 1, markedMessages: 1 });
      }
      if (url.includes('/api/feedback/mine')) return httpResponse(200, listResponse([item()], { unreadTotal: 1 }));
      if (url.includes('unread-summary')) {
        return httpResponse(200, { unreadFeedbacksCount: 0, totalUnreadMessages: 0 });
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    await toHistory(m);

    readAllBtn(m).click();
    await settled(12);
    let hint = readHint(m);
    expect(hint.hidden).toBe(false);
    // 文案格式必须带出具体原因并可重试：标记失败：<原因>，请重试
    expect(hint.textContent).toBe('标记失败：boom，请重试');
    expect(hint.classList.contains('is-error')).toBe(true);
    expect(readAllBtn(m).textContent).toBe('一键已读');
    // unreadTotal 仍为 1 → 可重试
    expect(readAllBtn(m).disabled).toBe(false);

    readAllBtn(m).click();
    await settled(20);
    hint = readHint(m);
    expect(hint.textContent).toBe('已全部标记为已读');
    expect(hint.classList.contains('is-error')).toBe(false);
    expect(readAllCalls).toBe(2);
  });

  it('身份切换后迟到的成功响应被丢弃，不写提示也不改动按钮状态', async () => {
    let resolveReadAll!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolveReadAll = resolve;
    });
    const m = mount();
    recordFetch(async (url) => {
      if (url.includes('/api/feedback/read-all')) return pending;
      if (url.includes('/api/feedback/mine')) return httpResponse(200, listResponse([item()], { unreadTotal: 1 }));
      return httpResponse(200, {});
    });
    await completeLogin(m);
    await toHistory(m);

    readAllBtn(m).click();
    // 身份切换（登出）：在途响应必须由 identityEpoch / 令牌守卫丢弃
    m.widget.dropSession();
    await settled();
    resolveReadAll(httpResponse(200, { ok: true, markedFeedbacks: 1, markedMessages: 1 }));
    await settled(20);

    expect(m.root.textContent).not.toContain('已全部标记为已读');
    expect(m.root.textContent).not.toContain('标记失败');
  });
});
