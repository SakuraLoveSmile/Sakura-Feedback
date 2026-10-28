import { useEffect, useState } from "react";
import { ApiError, api, type KaneoTestResult } from "../api.ts";
import { Field, InlineError, SkeletonRows } from "../ui.tsx";

interface KaneoGet {
  baseUrl: string | null;
  clientUrl: string | null;
  apiKeySet: boolean;
}
interface AiGet {
  baseUrl: string | null;
  model: string | null;
  apiKeySet: boolean;
}

type CardMsg = { kind: "ok" | "err"; text: string } | null;

export default function ConnectionsView() {
  const [k, setK] = useState<KaneoGet | null>(null);
  const [a, setA] = useState<AiGet | null>(null);
  const [kBaseUrl, setKBaseUrl] = useState("");
  const [kClientUrl, setKClientUrl] = useState("");
  const [kApiKey, setKApiKey] = useState("");
  const [aBaseUrl, setABaseUrl] = useState("");
  const [aModel, setAModel] = useState("");
  const [aApiKey, setAApiKey] = useState("");
  const [testProjectId, setTestProjectId] = useState("");
  /** 操作结果按卡片分别回显：贴近各自表单的保存/测试按钮。 */
  const [kMsg, setKMsg] = useState<CardMsg>(null);
  const [aMsg, setAMsg] = useState<CardMsg>(null);
  const [busy, setBusy] = useState(false);
  /** 初始加载：进行中显示骨架；失败显示可重试的页级错误（不再静默挂骨架）。 */
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 仅作手动重载触发器，effect 体只依赖网络请求结果
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [kk, aa] = await Promise.all([
          api.get<KaneoGet>("/api/admin/connection/kaneo"),
          api.get<AiGet>("/api/admin/connection/ai"),
        ]);
        if (!alive) return;
        setK(kk);
        setA(aa);
        setKBaseUrl(kk.baseUrl ?? "");
        setKClientUrl(kk.clientUrl ?? "");
        setABaseUrl(aa.baseUrl ?? "");
        setAModel(aa.model ?? "");
      } catch (err) {
        if (!alive) return;
        setLoadError(err instanceof ApiError ? err.message : "加载失败");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  async function run(fn: () => Promise<unknown>, okText: string, setMsg: (m: CardMsg) => void) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fn();
      const failed = typeof r === "object" && r !== null && "ok" in r && (r as KaneoTestResult).ok === false;
      if (failed) {
        setMsg({ kind: "err", text: `测试未通过：${(r as KaneoTestResult).reason}` });
      } else {
        const extra =
          typeof r === "object" && r !== null && "columns" in r
            ? `，加载到 ${(r as KaneoTestResult).columns?.length} 列（项目「${(r as KaneoTestResult).project?.name}」）`
            : typeof r === "object" && r !== null && "reply" in r
              ? `：${String((r as { reply?: string }).reply)}`
              : "";
        setMsg({ kind: "ok", text: okText + extra });
      }
    } catch (err) {
      setMsg({ kind: "err", text: err instanceof ApiError ? err.message : "请求失败" });
    } finally {
      setBusy(false);
    }
  }

  /** 卡内结果回显：错误红底 role=alert；成功绿底 role=status。就近的保存/测试按钮即重试入口。 */
  function renderMsg(msg: CardMsg) {
    if (!msg) return null;
    return msg.kind === "ok" ? (
      <p className="inline-ok" role="status">
        {msg.text}
      </p>
    ) : (
      <InlineError message={msg.text} />
    );
  }

  const busyTitle = busy ? "有操作进行中，稍候重试" : undefined;

  if (loadError && !k) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>连接配置</h1>
            <div className="sub">Kaneo 同步目标与 AI 整理服务；密钥只写服务器，不回显。</div>
          </div>
        </div>
        <InlineError message={loadError} onRetry={() => setReloadKey((x) => x + 1)} />
      </div>
    );
  }

  if (loading || !k || !a) {
    return (
      <div>
        <div className="page-header">
          <div>
            <h1>连接配置</h1>
            <div className="sub">Kaneo 同步目标与 AI 整理服务；密钥只写服务器，不回显。</div>
          </div>
        </div>
        <div className="card">
          <SkeletonRows rows={4} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>连接配置</h1>
          <div className="sub">Kaneo 同步目标与 AI 整理服务；密钥只写服务器，不回显。</div>
        </div>
      </div>
      <div className="cards-2col">
        <div className="card">
          <h2>Kaneo 连接</h2>
          <p className="form-section-desc">反馈自动同步到 Kaneo 任务的目标实例；留空的密钥表示沿用已保存值。</p>
          <Field id="kb" label="API 地址" hint="含或不含 /api 后缀均可。">
            {(ctl) => (
              <input
                {...ctl}
                value={kBaseUrl}
                onChange={(e) => setKBaseUrl(e.target.value)}
                placeholder="http://kaneo.local:1337"
              />
            )}
          </Field>
          <Field id="kc" label="Web 地址" hint="任务链接基址，可留空 = 同 API 地址。">
            {(ctl) => (
              <input
                {...ctl}
                value={kClientUrl}
                onChange={(e) => setKClientUrl(e.target.value)}
                placeholder="https://kaneo.example.com"
              />
            )}
          </Field>
          <Field
            id="kk"
            label={<>API Key {k.apiKeySet && <span className="ok-text">（已保存，留空则不修改）</span>}</>}
            hint="只写入服务器，保存后不再回显。"
          >
            {(ctl) => (
              <input
                {...ctl}
                type="password"
                value={kApiKey}
                onChange={(e) => setKApiKey(e.target.value)}
                placeholder={k.apiKeySet ? "••••••••" : "sk_…"}
              />
            )}
          </Field>
          <div className="btn-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title={busyTitle}
              onClick={() =>
                run(
                  async () => {
                    const r = await api.put("/api/admin/connection/kaneo", {
                      baseUrl: kBaseUrl,
                      clientUrl: kClientUrl || undefined,
                      ...(kApiKey ? { apiKey: kApiKey } : {}),
                    });
                    setKApiKey("");
                    const kk = await api.get<KaneoGet>("/api/admin/connection/kaneo");
                    setK(kk);
                    return r;
                  },
                  "Kaneo 配置已保存",
                  setKMsg,
                )
              }
            >
              保存
            </button>
          </div>
          {renderMsg(kMsg)}
          <p className="save-hint">保存位置：写入本服务器的连接配置；密钥加密存储、不回显。</p>
          <hr className="sep" />
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <Field id="tp" label="测试用项目 id" hint="填入要在 Kaneo 中校验连通性的项目 id。">
                {(ctl) => <input {...ctl} value={testProjectId} onChange={(e) => setTestProjectId(e.target.value)} />}
              </Field>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy || !testProjectId}
              title={busy ? busyTitle : !testProjectId ? "先填写测试用项目 id 才能发起连接测试" : undefined}
              onClick={() =>
                run(
                  () => api.post("/api/admin/connection/kaneo/test", { projectId: testProjectId }),
                  "连通正常",
                  setKMsg,
                )
              }
              style={{ marginTop: 22 }}
            >
              连接测试
            </button>
          </div>
        </div>

        <div className="card">
          <h2>AI（OpenAI 兼容）</h2>
          <p className="form-section-desc">反馈自动整理所用的 Chat Completions 服务；留空的密钥表示沿用已保存值。</p>
          <Field id="ab" label="接口地址" hint="Chat Completions 的基址，如 https://api.openai.com/v1。">
            {(ctl) => (
              <input
                {...ctl}
                value={aBaseUrl}
                onChange={(e) => setABaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            )}
          </Field>
          <Field id="am" label="模型" hint="例如 gpt-4o-mini。">
            {(ctl) => (
              <input {...ctl} value={aModel} onChange={(e) => setAModel(e.target.value)} placeholder="gpt-4o-mini" />
            )}
          </Field>
          <Field
            id="ak"
            label={<>密钥 {a.apiKeySet && <span className="ok-text">（已保存，留空则不修改）</span>}</>}
            hint="只写入服务器，保存后不再回显。"
          >
            {(ctl) => (
              <input
                {...ctl}
                type="password"
                value={aApiKey}
                onChange={(e) => setAApiKey(e.target.value)}
                placeholder={a.apiKeySet ? "••••••••" : "sk-…"}
              />
            )}
          </Field>
          <div className="btn-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              title={busyTitle}
              onClick={() =>
                run(
                  async () => {
                    const r = await api.put("/api/admin/connection/ai", {
                      baseUrl: aBaseUrl,
                      model: aModel,
                      ...(aApiKey ? { apiKey: aApiKey } : {}),
                    });
                    setAApiKey("");
                    const aa = await api.get<AiGet>("/api/admin/connection/ai");
                    setA(aa);
                    return r;
                  },
                  "AI 配置已保存",
                  setAMsg,
                )
              }
            >
              保存
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              title={busyTitle}
              onClick={() => run(() => api.post("/api/admin/connection/ai/test"), "AI 连通正常", setAMsg)}
            >
              连接测试
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              title={busyTitle}
              onClick={() =>
                run(() => api.post("/api/admin/connection/ai/test-vision"), "AI 图像识别测试正常", setAMsg)
              }
            >
              测试图像识别 (Vision)
            </button>
          </div>
          {renderMsg(aMsg)}
          <p className="save-hint">保存位置：写入本服务器的连接配置；密钥加密存储、不回显。</p>
        </div>
      </div>
    </div>
  );
}
