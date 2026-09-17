import { useEffect, useState } from "react";
import { ApiError, api, type KaneoTestResult } from "../api.ts";
import { Icon, PageHeader, SkeletonRows, StatusBadge } from "../ui.tsx";

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

type PanelMsg = { kind: "ok" | "err"; text: string } | null;

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
  /** 每个面板各自的就近提示（保存结果 / 测试结果显示在对应按钮旁）。 */
  const [kMsg, setKMsg] = useState<PanelMsg>(null);
  const [aMsg, setAMsg] = useState<PanelMsg>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const [kk, aa] = await Promise.all([
        api.get<KaneoGet>("/api/admin/connection/kaneo"),
        api.get<AiGet>("/api/admin/connection/ai"),
      ]);
      setK(kk);
      setA(aa);
      setKBaseUrl(kk.baseUrl ?? "");
      setKClientUrl(kk.clientUrl ?? "");
      setABaseUrl(aa.baseUrl ?? "");
      setAModel(aa.model ?? "");
    })();
  }, []);

  async function run(setMsg: (m: PanelMsg) => void, fn: () => Promise<unknown>, okText: string) {
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

  if (!k || !a) {
    return (
      <div className="page-config">
        <PageHeader title="连接配置" sub="Kaneo 同步目标与 AI 整理服务。" />
        <div className="card">
          <SkeletonRows rows={4} />
        </div>
      </div>
    );
  }

  const kaneoConfigured = Boolean(k.baseUrl) && k.apiKeySet;
  const aiConfigured = Boolean(a.baseUrl && a.model) && a.apiKeySet;

  return (
    <div className="page-config">
      <PageHeader title="连接配置" sub="Kaneo 同步目标与 AI 整理服务；密钥只写服务器，不回显。" />

      {/* Kaneo 面板 */}
      <div className="card">
        <div className="conn-panel-head">
          <span className="conn-icon">
            <Icon name="server" />
          </span>
          <h2>Kaneo</h2>
          <span className="conn-status">
            {kaneoConfigured ? (
              <StatusBadge tone="ok">已配置</StatusBadge>
            ) : (
              <StatusBadge tone="warn">未配置</StatusBadge>
            )}
          </span>
        </div>
        <p className="conn-desc">反馈的分类目标与任务同步到 Kaneo 工作区。</p>
        <div className="field">
          <label htmlFor="kb">API 地址</label>
          <input
            id="kb"
            value={kBaseUrl}
            onChange={(e) => setKBaseUrl(e.target.value)}
            placeholder="http://kaneo.local:1337"
          />
          <p className="field-help">含或不含 /api 后缀均可。</p>
        </div>
        <div className="field">
          <label htmlFor="kc">Web 地址</label>
          <input
            id="kc"
            value={kClientUrl}
            onChange={(e) => setKClientUrl(e.target.value)}
            placeholder="https://kaneo.example.com"
          />
          <p className="field-help">任务链接基址，可留空 = 同 API 地址。</p>
        </div>
        <div className="field">
          <label htmlFor="kk">API Key</label>
          <input
            id="kk"
            type="password"
            value={kApiKey}
            onChange={(e) => setKApiKey(e.target.value)}
            placeholder={k.apiKeySet ? "••••••••" : "sk_…"}
          />
          <p className="field-help">{k.apiKeySet ? "已保存，留空则不修改。" : "尚未保存密钥。"}</p>
        </div>
        <div className="row">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() =>
              run(
                setKMsg,
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
              )
            }
          >
            保存
          </button>
          {kMsg && (
            <span className={`test-result ${kMsg.kind}`}>
              <Icon name={kMsg.kind === "ok" ? "check" : "alert"} size={14} />
              {kMsg.text}
            </span>
          )}
        </div>
        <hr className="sep" />
        <div className="field" style={{ marginBottom: "var(--sp-2)" }}>
          <label htmlFor="tp">测试项目</label>
          <div className="row">
            <input
              id="tp"
              style={{ maxWidth: 320 }}
              value={testProjectId}
              onChange={(e) => setTestProjectId(e.target.value)}
              placeholder="Kaneo 项目 id"
            />
            <button
              type="button"
              className="btn"
              disabled={busy || !testProjectId}
              onClick={() =>
                run(
                  setKMsg,
                  () => api.post("/api/admin/connection/kaneo/test", { projectId: testProjectId }),
                  "连通正常",
                )
              }
            >
              连接测试
            </button>
          </div>
          <p className="field-help">测试使用已保存的配置（未保存的修改不参与测试）。</p>
        </div>
      </div>

      {/* AI 面板 */}
      <div className="card">
        <div className="conn-panel-head">
          <span className="conn-icon">
            <Icon name="sparkles" />
          </span>
          <h2>AI（OpenAI 兼容）</h2>
          <span className="conn-status">
            {aiConfigured ? <StatusBadge tone="ok">已配置</StatusBadge> : <StatusBadge tone="warn">未配置</StatusBadge>}
          </span>
        </div>
        <p className="conn-desc">把用户原话整理为标题与分段内容；图像识别用于截图理解。</p>
        <div className="field">
          <label htmlFor="ab">接口地址</label>
          <input
            id="ab"
            value={aBaseUrl}
            onChange={(e) => setABaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
          <p className="field-help">Chat Completions 的基址。</p>
        </div>
        <div className="field">
          <label htmlFor="am">模型</label>
          <input id="am" value={aModel} onChange={(e) => setAModel(e.target.value)} placeholder="gpt-4o-mini" />
        </div>
        <div className="field">
          <label htmlFor="ak">密钥</label>
          <input
            id="ak"
            type="password"
            value={aApiKey}
            onChange={(e) => setAApiKey(e.target.value)}
            placeholder={a.apiKeySet ? "••••••••" : "sk-…"}
          />
          <p className="field-help">{a.apiKeySet ? "已保存，留空则不修改。" : "尚未保存密钥。"}</p>
        </div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() =>
              run(
                setAMsg,
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
              )
            }
          >
            保存
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => run(setAMsg, () => api.post("/api/admin/connection/ai/test"), "AI 连通正常")}
          >
            文本测试
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => run(setAMsg, () => api.post("/api/admin/connection/ai/test-vision"), "图像识别正常")}
          >
            图像测试
          </button>
          {aMsg && (
            <span className={`test-result ${aMsg.kind}`}>
              <Icon name={aMsg.kind === "ok" ? "check" : "alert"} size={14} />
              {aMsg.text}
            </span>
          )}
        </div>
        <p className="field-help">测试使用已保存的配置（未保存的修改不参与测试）。</p>
      </div>
    </div>
  );
}
