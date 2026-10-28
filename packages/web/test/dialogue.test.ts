import { describe, it, expect, afterEach } from 'vitest';
import '../src/index';
import {
  cleanup,
  completeLogin,
  httpResponse,
  mount,
  recordFetch,
} from './helpers';

afterEach(cleanup);

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('Web Issue 对话与我的反馈', () => {
  it('未登录时进入「我的反馈」显示登录引导', async () => {
    const m = mount();
    m.fab.click();
    const historyTab = m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!;
    historyTab.click();
    await flush();

    expect(m.root.querySelector('.fb-history-empty')?.textContent).toContain('查看反馈历史需要登录');
  });

  it('已登录进入「我的反馈」拉取列表并展示状态与未读', async () => {
    const m = mount();
    recordFetch(async (url) => {
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, {
          items: [
            {
              id: 'fb-101',
              appId: 'com.example.app',
              title: '测试标题',
              text: '用户原话内容',
              status: 'received',
              issueStatus: 'waiting_user',
              dialogueVersion: 1,
              archiveRound: 1,
              lastActivityAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              unread: true,
              messageCount: 2,
              latestMessage: {
                seq: 2,
                senderType: 'admin',
                senderName: '管理员小张',
                text: '请提供更多日志',
                createdAt: new Date().toISOString(),
              },
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          unreadTotal: 1,
        });
      }
      return httpResponse(200, {});
    });

    await completeLogin(m);
    const historyTab = m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!;
    historyTab.click();
    await flush();

    const item = m.root.querySelector('.fb-history-item');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain('测试标题');
    expect(item?.textContent).toContain('待补充');
    expect(item?.textContent).toContain('未读');
    expect(item?.textContent).toContain('管理员: 请提供更多日志');
  });

  it('点击反馈项进入对话详情，自动上报已读并能发送回复', async () => {
    const m = mount();
    const calls: string[] = [];
    recordFetch(async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url.includes('/api/feedback/mine')) {
        return httpResponse(200, {
          items: [
            {
              id: 'fb-102',
              appId: 'com.example.app',
              title: '闪退问题',
              text: '启动时直接闪退',
              status: 'received',
              issueStatus: 'waiting_user',
              dialogueVersion: 1,
              archiveRound: 1,
              lastActivityAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
              unread: true,
              messageCount: 1,
              latestMessage: null,
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
          unreadTotal: 1,
        });
      }
      if (url.includes('/api/feedback/fb-102/dialogue')) {
        return httpResponse(200, {
          feedback: {
            id: 'fb-102',
            appId: 'com.example.app',
            title: '闪退问题',
            text: '启动时直接闪退',
            status: 'received',
            issueStatus: 'waiting_user',
            dialogueVersion: 1,
            archiveRound: 1,
            mgmtState: 'inbox',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
          },
          messages: [
            {
              id: 'msg-1',
              seq: 1,
              senderType: 'admin',
              senderId: 'admin-1',
              senderName: '运维团队',
              text: '请补充您的设备型号',
              createdAt: new Date().toISOString(),
              attachments: [],
            },
          ],
          lastReadSeq: 0,
        });
      }
      if (url.includes('/api/feedback/fb-102/read')) {
        return httpResponse(200, { ok: true, lastReadSeq: 1 });
      }
      if (url.includes('/api/feedback/fb-102/messages')) {
        return httpResponse(201, {
          ok: true,
          message: {
            id: 'msg-2',
            seq: 2,
            senderType: 'user',
            senderId: 'u-1',
            senderName: '我',
            text: '使用的是 Pixel 7',
            createdAt: new Date().toISOString(),
            attachments: [],
          },
          dialogueVersion: 2,
          issueStatus: 'waiting_admin',
        });
      }
      return httpResponse(200, {});
    });

    await completeLogin(m);
    const historyTab = m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!;
    historyTab.click();
    await flush();

    const item = m.root.querySelector<HTMLDivElement>('.fb-history-item')!;
    item.click();
    await flush();

    // 验证展示原话和管理员消息
    expect(m.root.querySelector('.fb-dialogue-view')?.textContent).toContain('启动时直接闪退');
    expect(m.root.querySelector('.fb-dialogue-view')?.textContent).toContain('请补充您的设备型号');

    // 验证自动触发已读上报
    expect(calls.some((c) => c.includes('POST') && c.includes('/read'))).toBe(true);

    // 发送回复
    const replyTextarea = m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!;
    replyTextarea.value = '使用的是 Pixel 7';
    replyTextarea.dispatchEvent(new Event('input'));

    const sendBtn = m.root.querySelector<HTMLButtonElement>('.fb-dialogue-reply-box button.fb-submit')!;
    sendBtn.click();
    await flush();

    expect(calls.some((c) => c.includes('POST') && c.includes('/messages'))).toBe(true);
  });
});
