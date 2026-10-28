/**
 * v13：「我的反馈」Tab 改成简易 GitHub issue 列表 + 项目分组/配色 的行为验收。
 *
 * 与既有硬绑定锚点的关系（这些类名/顺序不得破坏，本文件同时是它们的回归保护）：
 * `.fb-nav-btn`[1]、`.fb-history-items`、`.fb-history-item`、`.fb-history-title`、
 * `.fb-history-preview`、`.fb-history-date`、`.fb-history-filter`、`.fb-history-refresh`、
 * `.fb-history-page-prev/next` 与「第 N / M 页」。
 *
 * 另含两组保护：用户可控内容注入（末尾 describe），以及 v13 分组头 `--fb-bg` 上的色点/
 * reduced-motion 收口（原本的字符串包含式断言经变异验证为假绿，已改为块内断言）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import '../src/index';
import { STYLES } from '../src/styles';
import {
  PROJECT_NAME_MAX,
  projectColor,
  projectFallbackName,
} from '../src/project_color';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
  type Mounted,
} from './helpers';

afterEach(cleanup);

async function settled(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

/** `/mine` 桩数据：默认带 v13 三个新字段。 */
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fb-aaaa1111bbbb',
    appId: 'com.example.app',
    appName: '示例应用',
    title: '登录页白屏',
    text: '点开登录就白屏',
    issueStatus: 'open',
    lastActivityAt: '2026-10-12T09:00:00.000Z',
    createdAt: '2026-10-11T09:00:00.000Z',
    unread: false,
    messageCount: 3,
    imageCount: 2,
    logCount: 1,
    latestMessage: {
      seq: 3,
      senderType: 'admin',
      text: '已收到，正在复现',
      createdAt: '2026-10-12T09:00:00.000Z',
    },
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

/**
 * 未锁 app-id 的场景只能走宿主注入会话：面板内登录表单要求 app-id 必填
 * （`doLogin()` 直接以「缺少必填配置：api-base / app-id」拒绝），
 * 而 `adoptSession()` 不校验 app-id —— 这正是「一个用户跨多项目查看反馈」的真实入口。
 */
async function adoptSession(m: Mounted): Promise<void> {
  m.widget.adoptSession({
    accessToken: 'test-access-token',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  await settled();
}

/** 打开面板并切到「我的反馈」Tab（Tab 按钮仍靠 [1] 索引命中）。 */
async function toHistory(m: Mounted): Promise<void> {
  m.fab.click();
  await settled();
  m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
  await settled();
}

describe('issue 行式渲染', () => {
  it('行内渲染 #编号、状态中文、动态/图片/日志计数与更新时间', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([item({ issueStatus: 'waiting_user', unread: true })]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const row = m.root.querySelector<HTMLElement>('.fb-history-item')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('#fb-aaaa1'); // id 前 8 位（沿用历史口径）
    expect(row.textContent).toContain('待补充');
    expect(row.textContent).toContain('未读');
    expect(row.textContent).toContain('3 条动态');
    expect(row.textContent).toContain('2 图');
    expect(row.textContent).toContain('1 日志');
    expect(row.textContent).toContain(new Date('2026-10-12T09:00:00.000Z').toLocaleString());
    // 预览摘要与既有锚点保留
    expect(row.querySelector('.fb-history-preview')?.textContent).toBe('管理员: 已收到，正在复现');
    expect(row.querySelector('.fb-history-title')?.textContent).toBe('登录页白屏');
    expect(row.querySelector('.fb-history-date')).not.toBeNull();
    // 行带状态修饰类与项目色 data 属性
    expect(row.classList.contains('fb-issue--waiting_user')).toBe(true);
    expect(row.getAttribute('data-project-color')).toBe(projectColor('com.example.app'));
  });

  it('四种状态 chip 都有修饰类（open 此前没有，本轮补齐）', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(
            200,
            listResponse([
              item({ id: 'fb-open', issueStatus: 'open' }),
              item({ id: 'fb-wu', issueStatus: 'waiting_user' }),
              item({ id: 'fb-wa', issueStatus: 'waiting_admin' }),
              item({ id: 'fb-rs', issueStatus: 'resolved' }),
            ]),
          )
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const rows = Array.from(m.root.querySelectorAll<HTMLElement>('.fb-history-item'));
    expect(rows).toHaveLength(4);
    const tagClasses = rows.map((r) => r.querySelector('.fb-history-tags .fb-tag')!.className);
    expect(tagClasses).toEqual([
      expect.stringContaining('open'),
      expect.stringContaining('waiting-user'),
      expect.stringContaining('waiting-admin'),
      expect.stringContaining('resolved'),
    ]);
    expect(STYLES).toMatch(/\.fb-tag\.open \{[^}]*var\(--fb-status-info/);
    expect(STYLES).toMatch(/\.fb-history-item\.fb-issue-row\.fb-issue--open \{[^}]*var\(--fb-status-info-text\)/);
  });

  it('组件锁了 app-id 的单项目页：无分组头、也无冗余项目 chip', async () => {
    const m = mount(); // helpers.mount 默认 app-id=com.example.app
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([item()]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    expect(m.root.querySelectorAll('.fb-history-group')).toHaveLength(0);
    expect(m.root.querySelector('.fb-history-group-head')).toBeNull();
    expect(m.root.querySelectorAll('.fb-project-tag')).toHaveLength(0);
    expect(m.root.querySelectorAll('.fb-history-item')).toHaveLength(1);
  });

  it('未锁 app-id 且页内只有一个项目：不分组，但行内保留项目 chip（色点 + 名称）', async () => {
    const m = mount({ 'app-id': '' });
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([item({ appId: 'com.single.app', appName: '单体应用' })]))
        : httpResponse(200, {}),
    );
    await adoptSession(m);
    await toHistory(m);

    expect(m.root.querySelectorAll('.fb-history-group')).toHaveLength(0);
    const chip = m.root.querySelector('.fb-project-tag');
    expect(chip?.textContent).toBe('单体应用');
    expect(chip?.querySelector('.fb-project-dot')).not.toBeNull();
    expect(m.root.querySelector<HTMLElement>('.fb-history-item')!.getAttribute('data-project-color'))
      .toBe(projectColor('com.single.app'));
  });

  it('锁了 app-id、但页内唯一项目与它不同：仍出行内 chip 提示项目不一致', async () => {
    const m = mount(); // app-id=com.example.app
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([item({ appId: 'com.other.app', appName: '别的项目' })]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    expect(m.root.querySelectorAll('.fb-history-group')).toHaveLength(0);
    expect(m.root.querySelector('.fb-project-tag')?.textContent).toBe('别的项目');
  });
});

describe('项目分组（当前页内）', () => {
  it('页内出现多个项目 → 按首次出现顺序分组，分组头带色与条数', async () => {
    const m = mount({ 'app-id': '' });
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(
            200,
            listResponse([
              item({ id: 'fb-a1', appId: 'com.proj.alpha', appName: '阿尔法' }),
              item({ id: 'fb-b1', appId: 'com.proj.beta', appName: '贝塔' }),
              item({ id: 'fb-a2', appId: 'com.proj.alpha', appName: '阿尔法' }),
            ]),
          )
        : httpResponse(200, {}),
    );
    await adoptSession(m);
    await toHistory(m);

    const groups = Array.from(m.root.querySelectorAll<HTMLElement>('.fb-history-group'));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.getAttribute('data-app-id')).toBe('com.proj.alpha');
    expect(groups[0]!.querySelectorAll('.fb-history-item')).toHaveLength(2);
    expect(groups[1]!.querySelectorAll('.fb-history-item')).toHaveLength(1);

    const head0 = groups[0]!.querySelector('.fb-history-group-head')!;
    expect(head0?.textContent).toContain('阿尔法');
    expect(head0?.textContent).toContain('2 条');
    expect(groups[1]!.querySelector('.fb-history-group-count')?.textContent).toBe('1 条');
    // 分组语义给读屏：role=group + aria-label；色点纯装饰一律 aria-hidden
    expect(groups[0]!.getAttribute('role')).toBe('group');
    expect(groups[0]!.getAttribute('aria-label')).toBe('项目 阿尔法，2 条');
    for (const dot of Array.from(m.root.querySelectorAll('.fb-project-dot'))) {
      expect(dot.getAttribute('aria-hidden')).toBe('true');
    }

    // 同组行色 = 分组头色 = 该 appId 的稳定色；不同项目取不同色
    expect(head0.getAttribute('data-project-color')).toBe(projectColor('com.proj.alpha'));
    for (const row of Array.from(groups[0]!.querySelectorAll<HTMLElement>('.fb-history-item'))) {
      expect(row.getAttribute('data-project-color')).toBe(projectColor('com.proj.alpha'));
    }
    expect(projectColor('com.proj.beta')).not.toBe(projectColor('com.proj.alpha'));
    // 分组头已表达项目身份，行内不再重复 chip
    expect(m.root.querySelectorAll('.fb-project-tag')).toHaveLength(0);
  });

  it('组件锁了 app-id 但服务端混进别的项目时仍分组（数据优先于配置）', async () => {
    const m = mount(); // app-id=com.example.app
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([
            item({ id: 'fb-lock1', appId: 'com.example.app', appName: '示例应用' }),
            item({ id: 'fb-lock2', appId: 'com.other.app', appName: '别的项目' }),
          ]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const groups = Array.from(m.root.querySelectorAll<HTMLElement>('.fb-history-group'));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelector('.fb-history-group-name')?.textContent).toBe('示例应用');
    expect(groups[1]!.querySelector('.fb-history-group-name')?.textContent).toBe('别的项目');
  });

  it('同一 appId 在两次渲染中颜色稳定（列表刷新不随机换色）', async () => {
    const m = mount({ 'app-id': '' });
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([
            item({ id: 'fb-x1', appId: 'com.stable.one', appName: '稳定一' }),
            item({ id: 'fb-x2', appId: 'com.stable.two', appName: '稳定二' }),
          ]))
        : httpResponse(200, {}),
    );
    await adoptSession(m);
    await toHistory(m);

    const colorsOf = (): string[] =>
      Array.from(m.root.querySelectorAll<HTMLElement>('.fb-history-item')).map((r) =>
        r.getAttribute('data-project-color') ?? '',
      );
    const first = colorsOf();
    m.root.querySelector<HTMLButtonElement>('.fb-history-refresh')!.click();
    await settled();
    expect(colorsOf()).toEqual(first);
    expect(first[0]).toBe(projectColor('com.stable.one'));
    expect(first[1]).toBe(projectColor('com.stable.two'));
  });

  it('分组只在当前页内做：翻到下一页按下一页数据重新分组', async () => {
    const m = mount({ 'app-id': '' });
    let page = 1;
    recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        page = url.includes('page=2') ? 2 : 1;
        const items =
          page === 1
            ? [
                item({ id: 'fb-p1a', appId: 'com.proj.alpha', appName: '阿尔法' }),
                item({ id: 'fb-p1b', appId: 'com.proj.beta', appName: '贝塔' }),
              ]
            : [item({ id: 'fb-p2a', appId: 'com.proj.alpha', appName: '阿尔法' })];
        return httpResponse(200, listResponse(items, { total: 45, page }));
      }
      return httpResponse(200, {});
    });
    await adoptSession(m);
    await toHistory(m);

    expect(m.root.querySelectorAll('.fb-history-group')).toHaveLength(2);
    expect(m.root.textContent).toContain('第 1 / 3 页');

    m.root.querySelector<HTMLButtonElement>('.fb-history-page-next')!.click();
    await settled();
    // 第 2 页只有一个项目 → 不再出分组头（页内判定，不跨页合并）
    expect(m.root.querySelectorAll('.fb-history-group')).toHaveLength(0);
    expect(m.root.querySelectorAll('.fb-history-item')).toHaveLength(1);
    expect(m.root.textContent).toContain('第 2 / 3 页');
  });
});

describe('appName 回退与旧服务端缺字段', () => {
  it('appName 为 null → 回退显示 appId，不报错', async () => {
    const m = mount({ 'app-id': '' });
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([
            item({ id: 'fb-n1', appId: 'com.no.name.app', appName: null }),
            item({ id: 'fb-n2', appId: 'com.other.app', appName: '具名项目' }),
          ]))
        : httpResponse(200, {}),
    );
    await adoptSession(m);
    await toHistory(m);

    const heads = Array.from(m.root.querySelectorAll('.fb-history-group-head'));
    expect(heads).toHaveLength(2);
    expect(heads[0]!.textContent).toContain('com.no.name.app');
    expect(heads[1]!.textContent).toContain('具名项目');
    // 列表区没有走错误分支（面板级 .fb-error 区常驻，故只断言历史区文本）
    expect(m.root.querySelector('.fb-history-items')?.textContent).not.toContain('加载失败');
  });

  it('旧服务端（无 appName/imageCount/logCount、messageCount 缺失）→ 不出现 undefined / NaN', async () => {
    const m = mount();
    const legacy = item({ id: 'fb-legacy' }) as Record<string, unknown>;
    delete legacy.appName;
    delete legacy.imageCount;
    delete legacy.logCount;
    delete legacy.messageCount;
    delete legacy.latestMessage;
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([legacy]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const row = m.root.querySelector<HTMLElement>('.fb-history-item')!;
    expect(row.textContent).toContain('登录页白屏');
    expect(row.textContent).not.toContain('undefined');
    expect(row.textContent).not.toContain('NaN');
    expect(row.textContent).not.toContain('条动态');
    expect(row.querySelector('.fb-history-preview')?.textContent).toBe('点开登录就白屏');
  });

  it('计数为 0 或非数字 → 不渲染「0 图」这类噪音', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([
            item({ id: 'fb-zero', imageCount: 0, logCount: 0 }),
            item({ id: 'fb-nan', imageCount: Number.NaN, logCount: '3' as unknown as number }),
          ]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const rows = Array.from(m.root.querySelectorAll<HTMLElement>('.fb-history-item'));
    expect(rows[0]!.textContent).not.toContain('0 图');
    expect(rows[0]!.textContent).not.toContain('0 日志');
    expect(rows[1]!.textContent).not.toContain('NaN');
    expect(rows[1]!.textContent).not.toContain('图');
    expect(rows[1]!.textContent).not.toContain('日志');
  });

  it('时间字段非法 → 省略「更新于」而非输出 Invalid Date', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([
            item({ id: 'fb-badtime', lastActivityAt: 'not-a-date', createdAt: 'also-bad' }),
          ]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const row = m.root.querySelector<HTMLElement>('.fb-history-item')!;
    expect(row.textContent).not.toContain('Invalid Date');
    expect(row.textContent).not.toContain('更新于');
    expect(row.textContent).toContain('3 条动态');
  });

  it('无计数且无合法时间 → 只留一个「暂无更新记录」，不留零内容 meta 节点', async () => {
    const m = mount();
    const bare = item({
      id: 'fb-empty-meta',
      lastActivityAt: 'not-a-date',
      createdAt: 'also-bad',
    }) as Record<string, unknown>;
    delete bare.imageCount;
    delete bare.logCount;
    delete bare.messageCount;
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([bare]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const meta = m.root.querySelector<HTMLElement>('.fb-history-date')!;
    expect(meta.textContent).toBe('暂无更新记录');
    // 断言的是节点数：计数为空时不得再 append 一个 join('') 出来的空 span
    const metas = Array.from(meta.querySelectorAll('.fb-history-meta'));
    expect(metas).toHaveLength(1);
    expect(metas[0]?.textContent).toBe('暂无更新记录');
    expect(meta.querySelector('.fb-history-time')).toBeNull();
  });
});

describe('既有锚点与规格回归（440px 行式紧凑）', () => {
  it('筛选 options、Tab 数量与分页控件文案未被改造破坏', async () => {
    const m = mount({ 'app-id': '' });
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([item()], { total: 45 }))
        : httpResponse(200, {}),
    );
    await adoptSession(m);
    await toHistory(m);

    const tabs = m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn');
    expect(tabs).toHaveLength(2);
    const sel = m.root.querySelector<HTMLSelectElement>('.fb-history-filter')!;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([
      '全部状态',
      '待处理',
      '待补充',
      '等待回复',
      '已解决',
    ]);
    expect(m.root.querySelector('.fb-history-refresh')).not.toBeNull();
    expect(m.root.querySelector('.fb-history-items')).not.toBeNull();
    expect(m.root.querySelector('.fb-history-page-next')).not.toBeNull();
    expect(m.root.querySelector('.fb-history-page-prev')).not.toBeNull();
    expect(m.root.textContent).toContain('第 1 / 3 页');
    expect(m.root.querySelector('.fb-panel')?.getAttribute('aria-label')).toBe('记录体验');
  });

  it('新增样式只用主题令牌', () => {
    const dot = /\.fb-project-dot \{([^}]*)\}/.exec(STYLES);
    expect(dot).not.toBeNull();
    expect(dot![1]).toContain('var(--fb-project-color');
    const chip = /\.fb-tag\.fb-project-tag \{([^}]*)\}/.exec(STYLES);
    expect(chip![1]).toContain('var(--fb-project-chip-bg');
    expect(chip![1]).toContain('var(--fb-text)');
    // 主色与面板宽度冻结项未被触碰
    expect(STYLES).toContain('--fb-accent: #0071e3');
    expect(STYLES).toMatch(/\.fb-panel \{[^}]*width: min\(440px, calc\(100vw - 32px\)\)/);
  });

  /**
   * 这条用例原本是 `@media (prefers-reduced-motion)[\s\S]*\.fb-history-item\.fb-issue-row`，
   * 但 STYLES 里在 v13 之前（styles.ts:1632 起）已经有一段 reduce 收口块，贪婪的 `[\s\S]*`
   * 会让它一路匹配到后面任意一处同名选择器 —— 实测「把 v13 整段 reduce 块删掉」仍然全绿。
   * 这里改成先把块切出来、再在块内断言选择器与声明，缺任何一项都必须失败。
   */
  it('v13 行式列表有自己的 prefers-reduced-motion 收口块且真的关掉动画', () => {
    const bodies = [...STYLES.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(
      (m) => m[1] ?? '',
    );
    expect(bodies.length).toBeGreaterThanOrEqual(2); // 既有 + v13
    const found = bodies.find((b) => b.includes('.fb-history-item.fb-issue-row'));
    expect(found, '必须存在覆盖 .fb-history-item.fb-issue-row 的 reduce 块').toBeDefined();
    const body = found ?? '';
    expect(body).not.toBe('');
    for (const sel of [
      '.fb-history-item.fb-issue-row',
      '.fb-history-group-head',
      '.fb-tag.fb-project-tag',
      '.fb-tag.open',
    ]) {
      expect(body, `reduce 块需覆盖 ${sel}`).toContain(sel);
    }
    expect(body).toMatch(/transition:\s*none\s*!important/);
    expect(body).toMatch(/animation:\s*none\s*!important/);
    // 关键：块内每条 transition 声明都必须真的被关掉。
    // （用 `not.toMatch(/transition:\s*(?!none)/)` 是错的：`\s*` 回溯成空串后
    //   前瞻看到的是那个空格，`transition: none` 自己也会被判定为「残留动画」。）
    const transitions = [...body.matchAll(/transition:\s*([^;]+);/g)].map((x) => x[1]!.trim());
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(t, `reduce 块内 transition 必须为 none，实际 "${t}"`).toMatch(/^none\b/);
    }
  });
});

/**
 * 用户可控内容注入。Shadow DOM 只隔离样式，**不隔离 HTML 注入**：
 * 只要有一处把 title/appName/text/计数拼进 innerHTML，宿主页面里的攻击载荷就会真的执行。
 * 本组用例锁死「新增渲染只用 createElement + textContent + setAttribute」这条纪律。
 */
describe('用户可控内容注入（title / appName / text / 计数 / 状态 / appId）', () => {
  const IMG = '<img src=x onerror="alert(1)">';
  const HOSTILE_TITLE = `${IMG} " 反斜杠\\ 中文标题`;

  it('title / text / latestMessage 里的 HTML 只作为文本出现，不产生任何元素', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(
            200,
            listResponse([
              item({
                id: 'fb-inj1',
                title: HOSTILE_TITLE,
                text: `<script>alert(2)</script> "${IMG}"`,
                latestMessage: {
                  seq: 9,
                  senderType: 'admin',
                  text: '<a href="javascript:alert(3)">点我</a> "尾引号',
                  createdAt: '2026-10-12T09:00:00.000Z',
                },
              }),
            ]),
          )
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const row = m.root.querySelector<HTMLElement>('.fb-history-item')!;
    // 原文必须完整出现在 textContent 里（证明没被当标签吃掉）
    expect(row.querySelector('.fb-history-title')?.textContent).toBe(HOSTILE_TITLE);
    expect(row.querySelector('.fb-history-preview')?.textContent).toContain(
      '<a href="javascript:alert(3)">点我</a> "尾引号',
    );
    // 且 DOM 里绝不出现被解析出来的元素
    for (const sel of ['img', 'a', 'script']) {
      expect(row.querySelector(sel), `不得注入 <${sel}>`).toBeNull();
    }
    // 属性型注入面：行内任何子元素都不得携带 href / src / srcdoc
    for (const node of Array.from(row.querySelectorAll('*'))) {
      for (const attr of ['href', 'src', 'srcdoc']) {
        expect(node.hasAttribute(attr), `${node.tagName} 不应带 ${attr}`).toBe(false);
      }
    }
  });

  it('appName 含引号/尖括号时分组头与 aria-label 原样保留且不提前闭合', async () => {
    const m = mount({ 'app-id': '' });
    const evilName = `" 阿尔法"><img src=x onerror=alert(4)> 中文`;
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(
            200,
            listResponse([
              item({ id: 'fb-inj2a', appId: 'com.proj.alpha', appName: evilName }),
              item({ id: 'fb-inj2b', appId: 'com.proj.beta', appName: '贝塔' }),
            ]),
          )
        : httpResponse(200, {}),
    );
    await adoptSession(m);
    await toHistory(m);

    const groups = Array.from(m.root.querySelectorAll<HTMLElement>('.fb-history-group'));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.querySelector('.fb-history-group-name')?.textContent).toBe(evilName);
    expect(groups[0]!.querySelector('img')).toBeNull();
    // setAttribute 的取值可以含引号与尖括号，但必须整体作为属性值原样读回
    expect(groups[0]!.getAttribute('aria-label')).toBe(`项目 ${evilName}，1 条`);
    expect(groups[0]!.getAttribute('data-app-id')).toBe('com.proj.alpha');
  });

  it('恶意 issueStatus 只能在白名单类名里取值，不得往 className 追加额外 token', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([
            item({ id: 'fb-inj3', issueStatus: 'resolved fb-hidden' }),
            item({ id: 'fb-inj4', issueStatus: 'open"; animation: infinite' }),
            item({ id: 'fb-inj5', issueStatus: null }),
          ]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const rows = Array.from(m.root.querySelectorAll<HTMLElement>('.fb-history-item'));
    expect(rows).toHaveLength(3);
    const allowed = new Set([
      'fb-history-item',
      'fb-issue-row',
      'fb-issue--open',
      'fb-issue--waiting_user',
      'fb-issue--waiting_admin',
      'fb-issue--resolved',
      'fb-issue--unknown',
    ]);
    for (const row of rows) {
      for (const token of row.className.split(/\s+/)) {
        expect(allowed, `${row.id ?? ''} 出现越界类名 ${token}`).toContain(token);
      }
    }
    // 未登记状态一律收敛到 fb-issue--unknown，且原文只进 textContent
    expect(rows[0]!.className).toBe('fb-history-item fb-issue-row fb-issue--unknown');
    expect(rows[2]!.className).toBe('fb-history-item fb-issue-row fb-issue--unknown');
    const statusTag = rows[0]!.querySelector('.fb-history-tags .fb-tag')!;
    expect(statusTag.className).toBe('fb-tag'); // 状态 chip 的修饰类同样走白名单
    expect(statusTag.textContent).toBe('resolved fb-hidden');
  });

  it('appId 形如 CSS 声明片段时，写进 style 的只有色板常量，不含分号后的内容', async () => {
    const m = mount({ 'app-id': '' });
    const evilId = 'x;position:fixed;inset:0;background:url("http://evil.test/a.png")';
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(
            200,
            listResponse([item({ id: 'fb-inj6', appId: evilId, appName: null })]),
          )
        : httpResponse(200, {}),
    );
    await adoptSession(m);
    await toHistory(m);

    const row = m.root.querySelector<HTMLElement>('.fb-history-item')!;
    const style = row.getAttribute('style') ?? '';
    // 只允许两个自定义属性，且值分别是 #rrggbb 与 rgba(...)
    expect(style).toMatch(/^--fb-project-color:#[0-9a-f]{6};--fb-project-chip-bg:rgba\([\d, .]+\);$/);
    expect(style).not.toContain('position');
    expect(style).not.toContain('evil.test');
    expect(row.getAttribute('data-project-color')).toBe(projectColor(evilId));
    // appName 为 null 时走 appId 回退展示名；回退名同样只进 textContent，不变成标记
    const chip = row.querySelector('.fb-project-tag')!;
    const fallback = chip?.querySelector('.fb-project-name')?.textContent ?? '';
    expect(fallback).toBe(projectFallbackName(evilId));
    expect(fallback.length).toBeLessThanOrEqual(PROJECT_NAME_MAX);
    expect(fallback).not.toContain('<');
    expect(fallback).not.toContain('onerror');
    expect(chip?.querySelector('img')).toBeNull();
  });

  it('计数为字符串/数组等异常类型时只输出被正数过滤后的数字，不输出对象序列化片段', async () => {
    const m = mount();
    recordFetch(async (url) =>
      url.includes('/api/feedback/mine')
        ? httpResponse(200, listResponse([
            item({
              id: 'fb-inj7',
              imageCount: { toString: () => '<img src=x onerror=alert(5)>' } as unknown as number,
              logCount: [1, 2, 3] as unknown as number,
              messageCount: '9' as unknown as number,
            }),
          ]))
        : httpResponse(200, {}),
    );
    await completeLogin(m);
    await toHistory(m);

    const meta = m.root.querySelector('.fb-history-date')!;
    expect(meta.textContent).not.toContain('img');
    expect(meta.textContent).not.toContain('undefined');
    expect(meta.textContent).not.toContain('NaN');
    expect(meta.querySelector('img')).toBeNull();
  });
});
