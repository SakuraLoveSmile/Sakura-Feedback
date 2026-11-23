import { Badge, Button, Input, Paper } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type KaneoTestResult } from "../api.ts";
import { usePageEdits } from "../page-edits.ts";
import { Field, Icon, InlineError, SkeletonRows } from "../ui.tsx";

interface Connection {
  baseUrl: string | null;
  clientUrl?: string | null;
  model?: string | null;
  apiKeySet: boolean;
}

function ConnectionCard({ kind }: { kind: "kaneo" | "ai" }) {
  const kaneo = kind === "kaneo";
  const name = kaneo ? "Kaneo" : "AI";
  const path = `/api/admin/connection/${kind}`;
  const [saved, setSaved] = useState<Connection | null>(null);
  const [base, setBase] = useState("");
  const [extra, setExtra] = useState("");
  const [key, setKey] = useState("");
  const [project, setProject] = useState("");
  const [loadError, setLoadError] = useState("");
  const [action, setAction] = useState<"save" | "test" | "test-vision" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const readSeq = useRef(0);
  const load = useCallback(async () => {
    const request = ++readSeq.current;
    setLoadError("");
    try {
      const config = await api.get<Connection>(path);
      if (readSeq.current !== request) return;
      setSaved(config);
      setBase(config.baseUrl ?? "");
      setExtra((kaneo ? config.clientUrl : config.model) ?? "");
    } catch (err) {
      if (readSeq.current !== request) return;
      setLoadError(err instanceof ApiError ? err.message : "暂时无法读取配置");
    }
  }, [path, kaneo]);
  useEffect(() => {
    void load();
    return () => {
      readSeq.current++;
    };
  }, [load]);

  const dirty =
    !!saved &&
    (base.trim() !== (saved.baseUrl ?? "") ||
      extra.trim() !== ((kaneo ? saved.clientUrl : saved.model) ?? "") ||
      Boolean(key.trim()));
  const ready = Boolean(saved?.apiKeySet && saved.baseUrl && (kaneo || saved.model));
  usePageEdits(dirty, action !== null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (action || !dirty) return;
    setAction("save");
    setResult(null);
    try {
      const values = { baseUrl: base.trim(), ...(kaneo ? { clientUrl: extra.trim() } : { model: extra.trim() }) };
      const response = await api.put<{ apiKeySet: boolean }>(path, {
        ...values,
        ...(key.trim() ? { apiKey: key } : {}),
      });
      setSaved({ ...values, apiKeySet: response.apiKeySet });
      setBase(values.baseUrl);
      setExtra(extra.trim());
      setKey("");
      setResult({ ok: true, text: `${name} 配置已保存` });
    } catch (err) {
      setResult({ ok: false, text: err instanceof ApiError ? err.message : "保存失败，请重试" });
    } finally {
      setAction(null);
    }
  }

  async function test(mode: "test" | "test-vision") {
    if (action || dirty || !ready || (kaneo && !project.trim())) return;
    setAction(mode);
    setResult(null);
    try {
      const r = await api.post<KaneoTestResult & { reply?: string }>(
        `${path}/${mode}`,
        kaneo ? { projectId: project.trim() } : undefined,
      );
      const text =
        kaneo && r.project
          ? `连通正常，项目「${r.project.name}」有 ${r.columns?.length ?? 0} 列`
          : mode === "test-vision"
            ? "AI 图像识别测试正常"
            : "AI 连通正常";
      setResult({ ok: r.ok, text: r.ok ? text + (r.reply ? ` · ${r.reply}` : "") : r.reason || "连接测试失败" });
    } catch (err) {
      setResult({ ok: false, text: err instanceof ApiError ? err.message : "连接测试失败" });
    } finally {
      setAction(null);
    }
  }

  return (
    <Paper component="section" withBorder p="lg" className="card conn-card" aria-label={`${name} 连接`}>
      <div className="conn-head">
        <span className={`conn-icon ${kaneo ? "tone-info" : "tone-ai"}`}>
          <Icon name={kaneo ? "link" : "feedback"} />
        </span>
        <div className="conn-title">
          <h2 className="conn-name">{kaneo ? "Kaneo 连接" : "AI（OpenAI 兼容）"}</h2>
          <p>{kaneo ? "同步反馈到项目与任务列" : "整理反馈文字与截图"}</p>
        </div>
        {saved && (
          <Badge
            component="span"
            variant="light"
            radius="sm"
            color={dirty || !ready ? "orange" : "teal"}
            className="tag"
          >
            {dirty ? "未保存" : ready ? "已配置" : "待配置"}
          </Badge>
        )}
      </div>
      {loadError ? (
        <InlineError message={loadError} onRetry={() => void load()} />
      ) : !saved ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <form onSubmit={save} onChange={() => setResult(null)}>
            <fieldset className="connection-fields" disabled={!!action}>
              <Field id={kaneo ? "kb" : "ab"} label={kaneo ? "API 地址" : "接口地址"}>
                {(ctl) => (
                  <Input
                    error={ctl["aria-invalid"]}
                    {...ctl}
                    type="url"
                    required
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                    placeholder={kaneo ? "http://kaneo.local:1337" : "https://api.openai.com/v1"}
                  />
                )}
              </Field>
              <Field
                id={kaneo ? "kc" : "am"}
                label={kaneo ? "Web 地址" : "模型"}
                hint={kaneo ? "用于打开任务链接，留空时沿用 API 地址。" : undefined}
              >
                {(ctl) => (
                  <Input
                    error={ctl["aria-invalid"]}
                    {...ctl}
                    type={kaneo ? "url" : "text"}
                    maxLength={kaneo ? undefined : 100}
                    required={!kaneo}
                    value={extra}
                    onChange={(e) => setExtra(e.target.value)}
                  />
                )}
              </Field>
              <Field
                id={kaneo ? "kk" : "ak"}
                label={kaneo ? "API Key" : "密钥"}
                hint={saved.apiKeySet ? "已保存密钥。留空可沿用，输入新值可替换。" : "密钥加密保存在服务器。"}
              >
                {(ctl) => (
                  <Input
                    error={ctl["aria-invalid"]}
                    {...ctl}
                    type="password"
                    value={key}
                    autoComplete="new-password"
                    placeholder={saved.apiKeySet ? "••••••••" : "输入密钥"}
                    onChange={(e) => setKey(e.target.value)}
                  />
                )}
              </Field>
              <Button variant="filled" type="submit" className="btn primary" disabled={!dirty}>
                {action === "save" ? "保存中…" : "保存"}
              </Button>
            </fieldset>
          </form>
          <div className="connection-test">
            {kaneo && (
              <Field id="tp" label="测试用项目 id">
                {(ctl) => (
                  <Input
                    error={ctl["aria-invalid"]}
                    {...ctl}
                    value={project}
                    disabled={!!action}
                    onChange={(e) => {
                      setProject(e.target.value);
                      setResult(null);
                    }}
                  />
                )}
              </Field>
            )}
            <div className="btn-row">
              <Button
                type="button"
                className="btn"
                disabled={!!action || dirty || !ready || (kaneo && !project.trim())}
                onClick={() => void test("test")}
              >
                {action === "test" ? "测试中…" : "连接测试"}
              </Button>
              {!kaneo && (
                <Button
                  type="button"
                  className="btn"
                  disabled={!!action || dirty || !ready}
                  onClick={() => void test("test-vision")}
                >
                  {action === "test-vision" ? "测试中…" : "测试图像识别 (Vision)"}
                </Button>
              )}
            </div>
            {(dirty || !ready) && (
              <p className="field-hint">{dirty ? "请先保存修改，再测试这组配置。" : "配置地址和密钥后可测试连接。"}</p>
            )}
          </div>
          {result &&
            (result.ok ? (
              <p className="inline-ok" role="status">
                {result.text}
              </p>
            ) : (
              <InlineError message={result.text} />
            ))}
        </>
      )}
    </Paper>
  );
}

export default function ConnectionsView() {
  return (
    <div className="connections-page">
      <div className="page-header">
        <div>
          <h1>连接配置</h1>
          <div className="sub">管理任务同步与反馈整理使用的服务。</div>
        </div>
      </div>
      <div className="cards-2col conn-grid">
        <ConnectionCard kind="kaneo" />
        <ConnectionCard kind="ai" />
      </div>
    </div>
  );
}
