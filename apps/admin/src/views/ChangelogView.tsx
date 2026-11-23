import { Button, Input, Paper } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  type ChangelogEntry,
  type ChangelogEntryType,
  type ChangelogRelease,
  type FeedbackAppOption,
  type FeedbackListItem,
} from "../api.ts";
import { usePageEdits } from "../page-edits.ts";
import {
  ConfirmDialog,
  EmptyState,
  Field,
  Icon,
  InlineError,
  Modal,
  SectionIcon,
  SkeletonRows,
  useToast,
} from "../ui.tsx";

const GROUPS: { type: ChangelogEntryType; label: string }[] = [
  { type: "added", label: "新增" },
  { type: "improved", label: "改进" },
  { type: "fixed", label: "修复" },
];

type DraftEntry = ChangelogEntry & { key: string };
interface Draft {
  version: string;
  releaseDate: string;
  summary: string;
  upgradeNotes: string;
  entries: DraftEntry[];
}

// 只用于本地 React key；HTTP 局域网部署也能使用，不依赖安全上下文 API。
let entrySequence = 0;
function entryKey(): string {
  return `changelog-entry-${++entrySequence}`;
}

function newEntry(): DraftEntry {
  return { key: entryKey(), type: "improved", title: "", description: "", feedbacks: [] };
}

function toDraft(release: ChangelogRelease | null): Draft {
  if (!release) {
    return {
      version: "",
      releaseDate: new Intl.DateTimeFormat("sv-SE").format(new Date()),
      summary: "",
      upgradeNotes: "",
      entries: [newEntry()],
    };
  }
  return {
    version: release.version,
    releaseDate: release.releaseDate,
    summary: release.summary,
    upgradeNotes: release.upgradeNotes,
    entries: release.entries.map((e) => ({ ...e, key: entryKey() })),
  };
}

function payload(draft: Draft) {
  return { ...draft, entries: draft.entries.map(({ key: _key, ...entry }) => entry) };
}

function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : "操作失败，请检查连接后重试";
}

function FeedbackPicker({
  appId,
  selected,
  onChoose,
  onClose,
}: {
  appId: string;
  selected: Set<string>;
  onChoose: (item: FeedbackListItem) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<FeedbackListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);

  const load = useCallback(
    async (nextCursor: string | null) => {
      const requestEpoch = ++epoch.current;
      setBusy(true);
      setError(null);
      const params = new URLSearchParams({ appId, view: "all", limit: "30", q: query });
      if (nextCursor) params.set("cursor", nextCursor);
      try {
        const result = await api.get<{ items: FeedbackListItem[]; nextCursor: string | null }>(
          `/api/admin/feedback?${params}`,
        );
        if (epoch.current !== requestEpoch) return;
        setItems((prev) => (nextCursor ? [...prev, ...result.items] : result.items));
        setCursor(result.nextCursor);
      } catch (e) {
        if (epoch.current === requestEpoch) setError(errorMessage(e));
      } finally {
        if (epoch.current === requestEpoch) setBusy(false);
      }
    },
    [appId, query],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load(null);
    return () => {
      epoch.current++;
    };
  }, [load]);

  return (
    <Modal title="关联这款软件的反馈" onClose={onClose} wide>
      <p className="muted">选择后带入提出者署名；空白条目也会带入反馈标题，请在发布前确认表述。</p>
      <form
        className="changelog-search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(search.trim());
        }}
      >
        <Input
          aria-label="搜索关联反馈"
          type="search"
          maxLength={200}
          placeholder="搜索标题或内容"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button className="btn" type="submit" disabled={busy}>
          搜索
        </Button>
      </form>
      {error && <InlineError message={error} onRetry={() => void load(cursor)} />}
      {busy && items.length === 0 ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="changelog-feedback-list">
          {items.map((item) => (
            <div className="changelog-feedback-row" key={item.id}>
              <div>
                <strong>{item.title || item.textPreview || "未命名反馈"}</strong>
                <div className="muted">
                  {item.username || "匿名用户"} · {item.issueStatus === "resolved" ? "已解决" : "跟进中"} ·{" "}
                  {item.createdAt.slice(0, 10)}
                </div>
              </div>
              <Button className="btn" type="button" disabled={selected.has(item.id)} onClick={() => onChoose(item)}>
                {selected.has(item.id) ? "已关联" : "选择"}
              </Button>
            </div>
          ))}
          {!busy && !items.length && !error && (
            <EmptyState title="没有匹配的反馈" hint="只显示当前软件收件箱和已归档区的反馈。" />
          )}
        </div>
      )}
      {cursor && (
        <Button className="btn" type="button" disabled={busy} onClick={() => void load(cursor)}>
          {busy ? "加载中…" : "加载更多反馈"}
        </Button>
      )}
    </Modal>
  );
}

function ReleasePreview({ draft }: { draft: Draft }) {
  return (
    <article className="changelog-preview" aria-label="更新日志预览">
      <div className="release-dateline">
        <h2>{draft.version || "版本号"}</h2>
        <time dateTime={draft.releaseDate}>{draft.releaseDate}</time>
      </div>
      {draft.summary && <p>{draft.summary}</p>}
      {GROUPS.map((group) => {
        const entries = draft.entries.filter((entry) => entry.type === group.type);
        return (
          entries.length > 0 && (
            <section key={group.type}>
              <h3>{group.label}</h3>
              <ul>
                {entries.map((entry) => {
                  const credits = [
                    ...new Set(entry.feedbacks.map((f) => (f.creditName === null ? "匿名用户" : f.creditName.trim()))),
                  ].filter(Boolean);
                  return (
                    <li key={entry.key}>
                      <strong>{entry.title || "条目标题"}</strong>
                      {entry.description && <p>{entry.description}</p>}
                      {credits.length > 0 && <p className="changelog-credits">感谢 {credits.join("、")} 提出反馈。</p>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )
        );
      })}
      {draft.upgradeNotes && (
        <section>
          <h3>升级说明</h3>
          <p>{draft.upgradeNotes}</p>
        </section>
      )}
    </article>
  );
}

export default function ChangelogView() {
  const toast = useToast();
  const [apps, setApps] = useState<FeedbackAppOption[] | null>(null);
  const [appId, setAppId] = useState("");
  const [items, setItems] = useState<ChangelogRelease[]>([]);
  const [saved, setSaved] = useState<ChangelogRelease | null>(null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(null));
  const [baseline, setBaseline] = useState(() => JSON.stringify(payload(draft)));
  const [loading, setLoading] = useState(false);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [discard, setDiscard] = useState<{ run: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState<string | null>(null);
  const [feedbackLabels, setFeedbackLabels] = useState<Record<string, FeedbackListItem>>({});
  const epoch = useRef(0);
  const dirty = JSON.stringify(payload(draft)) !== baseline;
  usePageEdits(dirty, busy);
  const published = saved?.publishedAt != null;
  const selectedApp = apps?.find((app) => app.appId === appId);
  const pageUrl = `/changelog/${encodeURIComponent(appId)}`;

  const openRelease = useCallback((release: ChangelogRelease | null) => {
    const next = toDraft(release);
    setSaved(release);
    setDraft(next);
    setBaseline(JSON.stringify(payload(next)));
    setError(null);
    setPickerKey(null);
  }, []);

  const loadApps = useCallback(async () => {
    setAppError(null);
    try {
      const { items: result } = await api.get<{ items: FeedbackAppOption[] }>("/api/admin/changelog/apps");
      setApps(result);
      setAppId((current) => current || result[0]?.appId || "");
    } catch (e) {
      setAppError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  const loadReleases = useCallback(async () => {
    const requestEpoch = ++epoch.current;
    openRelease(null);
    setReleaseError(null);
    setItems([]);
    setFeedbackLabels({});
    if (!appId) return;
    setLoading(true);
    await api
      .get<{ items: ChangelogRelease[] }>(`/api/admin/changelog?${new URLSearchParams({ appId })}`)
      .then((result) => {
        if (epoch.current !== requestEpoch) return;
        setItems(result.items);
        openRelease(result.items[0] ?? null);
      })
      .catch((e: unknown) => {
        if (epoch.current === requestEpoch) setReleaseError(errorMessage(e));
      })
      .finally(() => {
        if (epoch.current === requestEpoch) setLoading(false);
      });
  }, [appId, openRelease]);

  useEffect(() => {
    void loadReleases();
    return () => {
      epoch.current++;
    };
  }, [loadReleases]);

  function changeDraft(run: () => void) {
    if (dirty) setDiscard({ run });
    else run();
  }

  function updateEntry(key: string, update: Partial<ChangelogEntry>) {
    setDraft((prev) => ({
      ...prev,
      entries: prev.entries.map((entry) => (entry.key === key ? { ...entry, ...update } : entry)),
    }));
  }

  function remember(release: ChangelogRelease) {
    setItems((prev) =>
      [release, ...prev.filter((item) => item.id !== release.id)].sort(
        (a, b) => b.releaseDate.localeCompare(a.releaseDate) || b.createdAt.localeCompare(a.createdAt),
      ),
    );
    openRelease(release);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { appId, ...payload(draft) };
      const result = saved
        ? await api.put<ChangelogRelease>(`/api/admin/changelog/${saved.id}`, {
            ...body,
            expectedRevision: saved.revision,
          })
        : await api.post<ChangelogRelease>("/api/admin/changelog", body);
      remember(result);
      toast("ok", "草稿已保存，尚未对外发布");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function changePublication() {
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<ChangelogRelease>(
        `/api/admin/changelog/${saved.id}/${published ? "unpublish" : "publish"}`,
        { expectedRevision: saved.revision },
      );
      remember(result);
      toast("ok", published ? "已取消发布，可继续编辑" : "已发布，软件展示页和接口已可读取");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyMarkdown() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/changelog/${encodeURIComponent(appId)}/markdown`, { credentials: "omit" });
      if (!response.ok) throw new Error("markdown_fetch_failed");
      await navigator.clipboard.writeText(await response.text());
      toast("ok", "已复制这款软件所有已发布版本的 Markdown");
    } catch {
      setError("复制失败，请打开 Markdown 文件后手动复制。");
    } finally {
      setBusy(false);
    }
  }

  const pickerEntry = draft.entries.find((entry) => entry.key === pickerKey);
  const locked = busy || published || loading || Boolean(releaseError);

  return (
    <div className="changelog-page">
      <div className="page-header">
        <div>
          <h1>更新日志</h1>
          <div className="sub">按软件编写版本记录，关联反馈并预览发布内容。</div>
        </div>
      </div>
      {appError && <InlineError message={appError} onRetry={() => void loadApps()} />}
      <Paper withBorder p="lg" className="card changelog-toolbar">
        <Field id="changelog-app" label="选择软件" hint={dirty ? "当前版本还有未保存的修改。" : undefined}>
          {(ctl) => (
            <Input
              component="select"
              rightSection={<Icon name="chevronDown" size={14} />}
              {...ctl}
              value={appId}
              disabled={busy || !apps?.length}
              onChange={(e) => {
                const next = e.target.value;
                changeDraft(() => setAppId(next));
              }}
            >
              {!apps?.length && (
                <option value="">{appError ? "软件未加载" : apps === null ? "加载软件…" : "暂无软件"}</option>
              )}
              {apps?.map((app) => (
                <option key={app.appId} value={app.appId}>
                  {app.name}
                  {app.deleted ? "（已删除）" : ""} · {app.appId}
                </option>
              ))}
            </Input>
          )}
        </Field>
        {appId && (
          <div className="changelog-actions">
            <Button component="a" className="btn" href={pageUrl} target="_blank" rel="noreferrer">
              <Icon name="external" size={16} />
              软件展示页
            </Button>
            <Button
              component="a"
              className="btn"
              href={`/api/changelog/${encodeURIComponent(appId)}/markdown`}
              target="_blank"
              rel="noreferrer"
            >
              Markdown 文件
            </Button>
            <Button
              className="btn"
              type="button"
              disabled={busy || !items.some((item) => item.publishedAt)}
              onClick={() => void copyMarkdown()}
            >
              复制已发布 Markdown
            </Button>
          </div>
        )}
      </Paper>
      {selectedApp?.deleted && (
        <p className="warn-text" role="status">
          这款软件已删除：日志记录保留，公开展示已停用。
        </p>
      )}
      {!appId && apps !== null && (
        <EmptyState title="先添加一款软件" hint="在软件配置中登记软件，或等待用户首次提交反馈后自动发现。" />
      )}
      {appId && (
        <div className="changelog-layout">
          <Paper component="aside" withBorder p="lg" className="card changelog-versions" aria-label="更新日志版本">
            <div className="changelog-section-head">
              <h2>
                <SectionIcon name="archive" />
                版本记录
              </h2>
              <Button
                className="btn"
                type="button"
                disabled={busy || loading || !!releaseError || selectedApp?.deleted}
                onClick={() => changeDraft(() => openRelease(null))}
              >
                新建版本
              </Button>
            </div>
            {releaseError ? (
              <InlineError message={releaseError} onRetry={() => void loadReleases()} />
            ) : loading ? (
              <SkeletonRows rows={3} />
            ) : items.length ? (
              <div className="changelog-version-list">
                {items.map((item) => (
                  <button
                    className={`changelog-version${saved?.id === item.id ? " selected" : ""}`}
                    key={item.id}
                    type="button"
                    aria-pressed={saved?.id === item.id}
                    disabled={busy}
                    onClick={() => {
                      if (item.id !== saved?.id) changeDraft(() => openRelease(item));
                    }}
                  >
                    <span>
                      <strong>{item.version}</strong>
                      <span className={item.publishedAt ? "ok-text" : "muted"}>
                        {item.publishedAt ? "已发布" : "草稿"}
                      </span>
                    </span>
                    <span className="muted">
                      {item.releaseDate} · {item.entries.length} 项更新
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted">还没有版本记录，可以编写第一份更新日志。</p>
            )}
          </Paper>
          {!releaseError && !loading && (
            <div className="changelog-editor">
              <Paper
                component="form"
                withBorder
                p="lg"
                className="card"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <div className="changelog-section-head">
                  <h2>{saved ? `${saved.version} · ${published ? "已发布" : "草稿"}` : "新建版本"}</h2>
                  <Button size="xs" className="btn sm" type="button" onClick={() => setPreviewOpen(true)}>
                    预览当前版本
                  </Button>
                  {dirty && (
                    <span className="warn-text" role="status">
                      未保存
                    </span>
                  )}
                </div>
                {published && <p className="field-hint">这个版本已对外展示。需要修改时，请先取消发布。</p>}
                {error && <InlineError message={error} />}
                <fieldset className="changelog-fields" disabled={locked || selectedApp?.deleted}>
                  <legend className="sr-only">版本信息与更新条目</legend>
                  <div className="fields-2col">
                    <Field id="changelog-version-input" label="版本号">
                      {(ctl) => (
                        <Input
                          error={ctl["aria-invalid"]}
                          {...ctl}
                          required
                          maxLength={80}
                          placeholder="例如 1.2.0"
                          value={draft.version}
                          onChange={(e) => setDraft({ ...draft, version: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field id="changelog-date" label="发布日期">
                      {(ctl) => (
                        <input
                          {...ctl}
                          required
                          type="date"
                          value={draft.releaseDate}
                          onChange={(e) => setDraft({ ...draft, releaseDate: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                  <Field id="changelog-summary" label="更新摘要" hint="用一两句话说明这次更新给用户带来的变化。">
                    {(ctl) => (
                      <Input
                        component="textarea"
                        multiline
                        error={ctl["aria-invalid"]}
                        {...ctl}
                        rows={2}
                        maxLength={2000}
                        value={draft.summary}
                        onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="changelog-section-head">
                    <h3>更新条目</h3>
                    <span className="muted">{draft.entries.length} / 100</span>
                  </div>
                  {draft.entries.map((entry, index) => (
                    <section className="changelog-entry" key={entry.key} aria-label={`更新条目 ${index + 1}`}>
                      <div className="changelog-section-head">
                        <strong>条目 {index + 1}</strong>
                        <Button
                          className="btn"
                          type="button"
                          aria-label={`移除条目 ${index + 1}`}
                          disabled={draft.entries.length === 1}
                          onClick={() =>
                            setDraft({ ...draft, entries: draft.entries.filter((item) => item.key !== entry.key) })
                          }
                        >
                          移除条目
                        </Button>
                      </div>
                      <div className="changelog-entry-heading">
                        <Field id={`entry-type-${entry.key}`} label="分类">
                          {(ctl) => (
                            <Input
                              component="select"
                              rightSection={<Icon name="chevronDown" size={14} />}
                              {...ctl}
                              value={entry.type}
                              onChange={(e) => updateEntry(entry.key, { type: e.target.value as ChangelogEntryType })}
                            >
                              {GROUPS.map((group) => (
                                <option key={group.type} value={group.type}>
                                  {group.label}
                                </option>
                              ))}
                            </Input>
                          )}
                        </Field>
                        <Field id={`entry-title-${entry.key}`} label="条目标题">
                          {(ctl) => (
                            <Input
                              error={ctl["aria-invalid"]}
                              {...ctl}
                              required
                              maxLength={120}
                              placeholder="例如：修复导出文件时偶发的闪退"
                              value={entry.title}
                              onChange={(e) => updateEntry(entry.key, { title: e.target.value })}
                            />
                          )}
                        </Field>
                      </div>
                      <Field id={`entry-description-${entry.key}`} label="变化说明">
                        {(ctl) => (
                          <Input
                            component="textarea"
                            multiline
                            error={ctl["aria-invalid"]}
                            {...ctl}
                            rows={2}
                            maxLength={2000}
                            placeholder="描述用户现在可以做成什么，避免直接粘贴内部讨论。"
                            value={entry.description}
                            onChange={(e) => updateEntry(entry.key, { description: e.target.value })}
                          />
                        )}
                      </Field>
                      {entry.feedbacks.map((ref, refIndex) => (
                        <div className="changelog-credit-row" key={ref.feedbackId}>
                          <Field
                            id={`credit-${entry.key}-${refIndex}`}
                            label={`公开署名 ${refIndex + 1}`}
                            hint={`关联反馈：${feedbackLabels[ref.feedbackId]?.title || ref.feedbackId}`}
                          >
                            {(ctl) => (
                              <Input
                                error={ctl["aria-invalid"]}
                                {...ctl}
                                required={ref.creditName !== null}
                                disabled={ref.creditName === null}
                                maxLength={80}
                                placeholder={ref.creditName === null ? "匿名用户" : "填写公开昵称"}
                                value={ref.creditName ?? ""}
                                onChange={(e) =>
                                  updateEntry(entry.key, {
                                    feedbacks: entry.feedbacks.map((f) =>
                                      f.feedbackId === ref.feedbackId ? { ...f, creditName: e.target.value } : f,
                                    ),
                                  })
                                }
                              />
                            )}
                          </Field>
                          <label className="changelog-anonymous">
                            <input
                              type="checkbox"
                              checked={ref.creditName === null}
                              onChange={(e) =>
                                updateEntry(entry.key, {
                                  feedbacks: entry.feedbacks.map((f) =>
                                    f.feedbackId === ref.feedbackId
                                      ? {
                                          ...f,
                                          creditName: e.target.checked
                                            ? null
                                            : feedbackLabels[ref.feedbackId]?.username || "",
                                        }
                                      : f,
                                  ),
                                })
                              }
                            />
                            匿名
                          </label>
                          <Button
                            className="btn"
                            type="button"
                            aria-label={`移除署名 ${refIndex + 1}`}
                            onClick={() =>
                              updateEntry(entry.key, {
                                feedbacks: entry.feedbacks.filter((f) => f.feedbackId !== ref.feedbackId),
                              })
                            }
                          >
                            移除关联
                          </Button>
                        </div>
                      ))}
                      <Button
                        className="btn"
                        type="button"
                        disabled={entry.feedbacks.length >= 20}
                        onClick={() => setPickerKey(entry.key)}
                      >
                        <Icon name="link" size={16} />
                        关联反馈
                      </Button>
                      <p className="field-hint">
                        默认使用提出者账号名称，可改为公开昵称或匿名；不关联反馈的条目也可以发布。
                      </p>
                    </section>
                  ))}
                  <Button
                    className="btn"
                    type="button"
                    disabled={draft.entries.length >= 100}
                    onClick={() => setDraft({ ...draft, entries: [...draft.entries, newEntry()] })}
                  >
                    添加更新条目
                  </Button>
                  <Field
                    id="changelog-upgrade"
                    label="升级说明（可选）"
                    hint="需要用户操作、兼容性变化或已知限制放在这里。"
                  >
                    {(ctl) => (
                      <Input
                        component="textarea"
                        multiline
                        error={ctl["aria-invalid"]}
                        {...ctl}
                        rows={3}
                        maxLength={4000}
                        value={draft.upgradeNotes}
                        onChange={(e) => setDraft({ ...draft, upgradeNotes: e.target.value })}
                      />
                    )}
                  </Field>
                </fieldset>
                <div className="changelog-actions changelog-save">
                  {!published && (
                    <Button
                      variant="filled"
                      className="btn primary"
                      type="submit"
                      disabled={locked || selectedApp?.deleted || (!dirty && saved !== null)}
                    >
                      {busy ? "处理中…" : "保存草稿"}
                    </Button>
                  )}
                  {saved && (
                    <Button
                      variant={published ? "default" : "filled"}
                      className={`btn ${published ? "" : "primary"}`}
                      type="button"
                      disabled={busy || dirty || (selectedApp?.deleted && !published)}
                      onClick={() => void changePublication()}
                    >
                      {published ? "取消发布" : "发布更新日志"}
                    </Button>
                  )}
                  {dirty && (
                    <Button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => changeDraft(() => openRelease(saved))}
                    >
                      撤销未保存的修改
                    </Button>
                  )}
                  {error && (
                    <Button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => changeDraft(() => void loadReleases())}
                    >
                      {dirty ? "舍弃修改并重新载入" : "重新载入版本"}
                    </Button>
                  )}
                </div>
              </Paper>
            </div>
          )}
        </div>
      )}
      {previewOpen && (
        <Modal
          title="展示预览"
          wide
          onClose={() => setPreviewOpen(false)}
          actions={
            <Button className="btn" type="button" onClick={() => setPreviewOpen(false)}>
              返回编辑
            </Button>
          }
        >
          <ReleasePreview draft={draft} />
        </Modal>
      )}
      {discard && (
        <ConfirmDialog
          title="放弃本版本的修改？"
          body={<p>继续后会丢弃尚未保存的编辑。</p>}
          danger
          confirmLabel="放弃修改并继续"
          onClose={() => setDiscard(null)}
          onConfirm={() => {
            setDiscard(null);
            discard.run();
          }}
        />
      )}
      {pickerEntry && (
        <FeedbackPicker
          appId={appId}
          selected={new Set(pickerEntry.feedbacks.map((f) => f.feedbackId))}
          onClose={() => setPickerKey(null)}
          onChoose={(item) => {
            setFeedbackLabels((prev) => ({ ...prev, [item.id]: item }));
            updateEntry(pickerEntry.key, {
              title: pickerEntry.title || (item.title || item.textPreview || "").slice(0, 120),
              feedbacks: [...pickerEntry.feedbacks, { feedbackId: item.id, creditName: item.username || null }],
            });
            setPickerKey(null);
          }}
        />
      )}
    </div>
  );
}
