import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/index';
import { cleanup, completeLogin, flushPromises, httpResponse, mount, recordFetch, setTextarea, type Mounted } from './helpers';
import type { FeedbackDialogueResponse, UserFeedbackListItem } from '../src/api';

afterEach(() => { vi.useRealTimers(); cleanup(); });
const createdAt = '2026-10-01T08:00:00.000Z';
function dialogue(id = 'fb-track-1', issueStatus: 'open' | 'waiting_user' | 'waiting_admin' | 'resolved' = 'open'): FeedbackDialogueResponse {
  return { feedback: { id, appId: 'com.example.app', title: '完整标题：在手机上复现的很长问题描述', text: '原始反馈内容', status: 'received', issueStatus, dialogueVersion: 1, archiveRound: 1, mgmtState: 'normal', createdAt, updatedAt: createdAt, lastActivityAt: createdAt }, messages: [], lastReadSeq: 0 };
}
function item(id = 'fb-track-1'): UserFeedbackListItem {
  return { ...dialogue(id).feedback, unread: true, messageCount: 3, latestMessage: { seq: 3, senderType: 'system', senderName: '', text: '处理记录已更新', createdAt } };
}
function list(ids = ['fb-track-1']) {
  return httpResponse(200, { items: ids.map(item), total: ids.length, page: 1, limit: 20, unreadTotal: 1 });
}
function history(m: Mounted): void {
  m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[1]!.click();
}
function openFirst(m: Mounted): void {
  m.root.querySelector<HTMLDivElement>('.fb-history-item')!.click();
}
function refresh(m: Mounted): void {
  m.root.querySelector<HTMLButtonElement>('.fb-dialogue-refresh')!.click();
}
function reply(m: Mounted, text: string): HTMLTextAreaElement {
  const textarea = m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input'));
  return textarea;
}
function addLog(m: Mounted): void {
  const input = m.root.querySelectorAll<HTMLInputElement>('.fb-dialogue-reply-box input[type=file]')[1]!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['log'], 'follow-up.log', { type: 'text/plain' })] });
  input.dispatchEvent(new Event('change'));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('手机提交回执与问题追踪', () => {
  it('已接受后显示保存回执；后台失败仍可查看原反馈，刷新不会再次提交', async () => {
    const m = mount();
    const { calls } = recordFetch(async (url, init) => {
      if (url.endsWith('/api/feedback') && init.method === 'POST') return httpResponse(201, { feedbackId: 'fb-track-1', status: 'received', collectionState: 'waiting_configuration' });
      if (url.endsWith('/fb-track-1')) return httpResponse(200, { id: 'fb-track-1', status: 'failed', createdAt, updatedAt: createdAt, errorSummary: '后台暂时失败', kaneoUrl: null });
      if (url.endsWith('/dialogue')) return httpResponse(200, dialogue());
      return httpResponse(200, {});
    });
    await completeLogin(m, undefined, { dialogue: true, images: 5 });
    setTextarea(m, '提交后希望查看进展');
    m.submitBtn.click();
    await flushPromises();
    expect(m.root.querySelector('.fb-submission-receipt')?.textContent).toContain('已提交并保存');
    expect(m.root.querySelector('.fb-submission-receipt')?.textContent).toContain('fb-track-1');
    expect(m.root.querySelector('.fb-dialogue-title')).toBeNull();
    m.root.querySelector<HTMLButtonElement>('.fb-refresh-btn')!.click();
    await flushPromises();
    expect(m.errorRegion.textContent).toContain('后台整理未完成');
    m.root.querySelector<HTMLButtonElement>('.fb-view-progress')!.click();
    await flushPromises();
    expect(m.root.querySelectorAll('.fb-nav-btn')[1]!.classList.contains('active')).toBe(true);
    expect(m.root.querySelector('.fb-dialogue-title')?.textContent).toContain('完整标题');
    refresh(m);
    await flushPromises();
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/feedback'))).toHaveLength(1);
  });

  it('服务端未声明 dialogue 时保留原提交后行为', async () => {
    const m = mount();
    recordFetch(async (url) => url.endsWith('/api/feedback')
      ? httpResponse(201, { feedbackId: 'fb-track-1', status: 'received', collectionState: 'waiting_configuration' }) : httpResponse(200, {}));
    await completeLogin(m);
    setTextarea(m, '兼容旧服务');
    m.submitBtn.click();
    await flushPromises();
    expect(m.root.querySelector('.fb-view-progress')).toBeNull();
  });

  it('列表显示系统角色、动态数与最后活动时间；请求失败显示可重试错误', async () => {
    const m = mount();
    let fail = false;
    recordFetch(async (url) => {
      if (url.includes('/mine')) {
        if (fail) throw new Error('网络断开');
        const data = item();
        data.lastActivityAt = '2026-10-12T09:00:00.000Z';
        return httpResponse(200, { items: [data], total: 1, page: 1, limit: 20, unreadTotal: 1 });
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    const card = m.root.querySelector('.fb-history-item')!;
    expect(card.textContent).toContain('系统: 处理记录已更新');
    expect(card.textContent).toContain('3 条动态');
    expect(card.textContent).toContain(new Date('2026-10-12T09:00:00.000Z').toLocaleString());
    fail = true;
    m.root.querySelector<HTMLButtonElement>('.fb-history-refresh')!.click();
    await flushPromises();
    expect(m.root.querySelector('.fb-history-items')?.textContent).toContain('网络断开');
    expect(m.root.querySelector('.fb-history-items')?.textContent).toContain('重试');
    expect(m.root.querySelector('.fb-history-items')?.textContent).not.toContain('暂无反馈');
  });

  it('初次详情失败仍能返回、重试，重试仅重新读取详情', async () => {
    const m = mount();
    let fail = true;
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/mine')) return list();
      if (url.endsWith('/dialogue')) {
        if (fail) throw new Error('断开连接');
        return httpResponse(200, dialogue());
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    expect(m.root.querySelector('.fb-dialogue-back')).not.toBeNull();
    expect(m.root.querySelector('.fb-dialogue-view')?.textContent).toContain('断开连接');
    fail = false;
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-retry')!.click();
    await flushPromises();
    expect(m.root.querySelector('.fb-dialogue-title')).not.toBeNull();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('刷新失败及恢复保留输入、日志、编辑器节点和阅读位置，并从真实消息显示最近处理说明', async () => {
    const m = mount();
    let fail = false;
    const data = dialogue('fb-track-1', 'resolved');
    data.messages = [{ id: 'msg-1', seq: 1, senderType: 'admin', senderId: 'admin', senderName: '管理员', text: '已修复', resolutionNote: '更新应用后再试', createdAt, attachments: [] }];
    data.lastReadSeq = 1;
    recordFetch(async (url) => {
      if (url.includes('/mine')) return list();
      if (url.endsWith('/dialogue')) {
        if (fail) throw new Error('刷新断网');
        return httpResponse(200, data);
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    const textarea = reply(m, '问题仍能复现');
    addLog(m);
    const messages = m.root.querySelector<HTMLDivElement>('.fb-dialogue-messages')!;
    messages.scrollTop = 23;
    fail = true;
    refresh(m);
    await flushPromises();
    expect(m.root.querySelector('.fb-dialogue-view')?.textContent).toContain('刷新失败');
    fail = false;
    refresh(m);
    await flushPromises();
    expect(m.root.querySelector('.fb-dialogue-reply-box textarea')).toBe(textarea);
    expect(textarea.value).toBe('问题仍能复现');
    expect(m.root.querySelector('.fb-reply-images')?.textContent).toContain('follow-up.log');
    expect(messages.scrollTop).toBe(23);
    expect(m.root.querySelector('.fb-dialogue-header')?.textContent).toContain('原反馈中继续补充');
    expect(m.root.querySelector('.fb-dialogue-messages > .fb-resolution-note')?.textContent).toBe('最近处理说明：更新应用后再试');
  });

  it('同一详情的迟到旧响应不能覆盖较新的状态', async () => {
    const m = mount();
    const old = deferred<ReturnType<typeof httpResponse>>();
    let request = 0;
    recordFetch(async (url) => {
      if (url.includes('/mine')) return list();
      if (url.endsWith('/dialogue')) {
        request++;
        return request === 2 ? old.promise : httpResponse(200, dialogue('fb-track-1', request === 3 ? 'resolved' : 'open'));
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    refresh(m);
    refresh(m);
    await flushPromises();
    old.resolve(httpResponse(200, dialogue('fb-track-1', 'waiting_user')));
    await flushPromises();
    expect(m.root.querySelector('.fb-dialogue-header .fb-tag')?.textContent).toBe('已解决');
  });

  it('切换账号后丢弃旧详情和未读响应，不向新账号上报旧反馈已读', async () => {
    const m = mount();
    const old = deferred<ReturnType<typeof httpResponse>>();
    const summary = deferred<ReturnType<typeof httpResponse>>();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/mine')) return list();
      if (url.includes('unread-summary')) return summary.promise;
      if (url.endsWith('/dialogue')) return old.promise;
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    m.widget.adoptSession({ accessToken: 'new-account-token', expiresAt: Date.now() + 3_600_000 });
    const data = dialogue();
    data.messages = [{ id: 'msg-old', seq: 1, senderType: 'admin', senderId: 'admin', senderName: '旧账号消息', text: '私有旧内容', createdAt, attachments: [] }];
    old.resolve(httpResponse(200, data));
    summary.resolve(httpResponse(200, { totalUnreadMessages: 99, unreadFeedbacksCount: 1 }));
    await flushPromises();
    expect(m.root.textContent).not.toContain('私有旧内容');
    expect(m.root.querySelector('.fb-tab-badge')?.textContent ?? '').not.toBe('99');
    expect(calls.filter((call) => call.url.endsWith('/read'))).toHaveLength(0);
  });

  it('返回列表、切其他问题及关闭重开保留各问题补充草稿，账号切换清除', async () => {
    const m = mount();
    recordFetch(async (url) => {
      if (url.includes('/mine')) return list(['fb-track-1', 'fb-track-2']);
      if (url.endsWith('/dialogue')) return httpResponse(200, dialogue(url.includes('fb-track-2') ? 'fb-track-2' : 'fb-track-1'));
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    reply(m, '问题一的补充');
    addLog(m);
    const oldLogPicker = m.root.querySelectorAll<HTMLInputElement>('.fb-dialogue-reply-box input[type=file]')[1]!;
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-back')!.click();
    await flushPromises();
    m.root.querySelectorAll<HTMLDivElement>('.fb-history-item')[1]!.click();
    await flushPromises();
    expect(m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!.value).toBe('');
    oldLogPicker.dispatchEvent(new Event('change'));
    expect(m.root.querySelector('.fb-reply-images')?.textContent).not.toContain('follow-up.log');
    reply(m, '问题二的补充');
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-back')!.click();
    await flushPromises();
    openFirst(m);
    await flushPromises();
    expect(m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!.value).toBe('问题一的补充');
    expect(m.root.querySelector('.fb-reply-images')?.textContent).toContain('follow-up.log');
    m.widget.close();
    m.widget.open();
    await flushPromises();
    expect(m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!.value).toBe('问题一的补充');
    m.root.querySelectorAll<HTMLButtonElement>('.fb-nav-btn')[0]!.click();
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    expect(m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!.value).toBe('问题一的补充');
    m.widget.dropSession();
    expect(m.root.querySelector('.fb-dialogue-reply-box')).toBeNull();
  });

  it('发送失败保留補充附件；挂起请求可离开重开，仍防止同反馈重复 POST', async () => {
    const m = mount();
    const pending = deferred<ReturnType<typeof httpResponse>>();
    const { calls } = recordFetch(async (url) => {
      if (url.includes('/mine')) return list();
      if (url.endsWith('/dialogue')) return httpResponse(200, dialogue('fb-track-1', 'resolved'));
      if (url.endsWith('/messages')) return pending.promise;
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    const textarea = reply(m, '解决后仍有疑问');
    addLog(m);
    const send = m.root.querySelector<HTMLButtonElement>('.fb-dialogue-reply-box .fb-submit')!;
    send.dispatchEvent(new Event('click'));
    send.dispatchEvent(new Event('click'));
    m.widget.close();
    expect(m.panel.hidden).toBe(true);
    m.widget.open();
    await flushPromises();
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-back')!.click();
    await flushPromises();
    openFirst(m);
    await flushPromises();
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-reply-box .fb-submit')!.dispatchEvent(new Event('click'));
    pending.resolve(httpResponse(500, { error: { code: 'temporary', message: '发送暂时失败' } }));
    await flushPromises();
    expect(textarea.value).toBe('解决后仍有疑问');
    expect(m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!.value).toBe('解决后仍有疑问');
    expect(m.root.querySelector('.fb-reply-images')?.textContent).toContain('follow-up.log');
    expect(m.root.querySelector<HTMLButtonElement>('.fb-dialogue-reply-box .fb-submit')!.disabled).toBe(false);
    expect(calls.filter((call) => call.url.endsWith('/messages'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/api/feedback'))).toHaveLength(0);
  });
  it.each(['waiting_configuration', 'waiting_manual_archive'])('等待态 %s 不自动轮询也立即提供保存回执和查看进展', async (collectionState) => {
    const m = mount();
    const { calls } = recordFetch(async (url) => url.endsWith('/api/feedback')
      ? httpResponse(201, { feedbackId: 'fb-track-1', status: 'received', collectionState }) : httpResponse(200, {}));
    await completeLogin(m, undefined, { dialogue: true, images: 5 });
    setTextarea(m, '等待服务配置');
    m.submitBtn.click();
    await flushPromises();
    expect(m.root.querySelector('.fb-view-progress')).not.toBeNull();
    expect(m.root.querySelector('.fb-submission-receipt')?.textContent).toContain('已提交并保存');
    expect(m.root.querySelector('.fb-body')?.classList.contains('has-submitted-feedback')).toBe(true);
    m.root.querySelector<HTMLButtonElement>('.fb-receipt-new')!.click();
    expect(m.root.querySelector('.fb-body')?.classList.contains('has-submitted-feedback')).toBe(false);
    expect(calls.filter((call) => call.method === 'GET' && call.url.endsWith('/fb-track-1'))).toHaveLength(0);
  });

  it('自动刷新跨过 10 秒间隔时不叠加请求，迟缓响应仍能更新详情', async () => {
    vi.useFakeTimers();
    const m = mount();
    const slow = deferred<ReturnType<typeof httpResponse>>();
    let count = 0;
    recordFetch(async (url) => {
      if (url.includes('/mine')) return list();
      if (url.endsWith('/dialogue')) {
        count++;
        return count === 2 ? slow.promise : httpResponse(200, dialogue());
      }
      return httpResponse(200, {});
    });
    await completeLogin(m);
    m.widget.open();
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(count).toBe(2);
    slow.resolve(httpResponse(200, dialogue('fb-track-1', 'resolved')));
    await flushPromises();
    expect(m.root.querySelector('.fb-dialogue-header .fb-tag')?.textContent).toBe('已解决');
  });

  it('发送成功的迟到响应仅清除对应问题草稿，不清另一个正在编辑的问题', async () => {
    const m = mount();
    const pending = deferred<ReturnType<typeof httpResponse>>();
    recordFetch(async (url) => {
      if (url.includes('/mine')) return list(['fb-track-1', 'fb-track-2']);
      if (url.endsWith('/dialogue')) return httpResponse(200, dialogue(url.includes('fb-track-2') ? 'fb-track-2' : 'fb-track-1'));
      if (url.endsWith('/messages')) return pending.promise;
      return httpResponse(200, {});
    });
    await completeLogin(m);
    history(m);
    await flushPromises();
    openFirst(m);
    await flushPromises();
    reply(m, '问题一待发送');
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-reply-box .fb-submit')!.click();
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-back')!.click();
    await flushPromises();
    m.root.querySelectorAll<HTMLDivElement>('.fb-history-item')[1]!.click();
    await flushPromises();
    const other = reply(m, '问题二正在编辑');
    addLog(m);
    pending.resolve(httpResponse(201, { ok: true, message: {}, dialogueVersion: 1, issueStatus: 'waiting_admin' }));
    await flushPromises();
    expect(other.value).toBe('问题二正在编辑');
    expect(m.root.querySelector('.fb-reply-images')?.textContent).toContain('follow-up.log');
    m.root.querySelector<HTMLButtonElement>('.fb-dialogue-back')!.click();
    await flushPromises();
    openFirst(m);
    await flushPromises();
    expect(m.root.querySelector<HTMLTextAreaElement>('.fb-dialogue-reply-box textarea')!.value).toBe('');
  });

});
