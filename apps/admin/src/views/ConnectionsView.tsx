import { useEffect, useState } from "react";
import { ApiError, api, type KaneoTestResult } from "../api.ts";
import { Field, SkeletonRows } from "../ui.tsx";

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
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
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

  async function run(fn: () => Promise<unknown>, okText: string) {
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
      <div>
        <div className="page-header">
          <div>
            <h1>连接配置</h1>
            <div className="sub">Kaneo 同步目标与 AI 整理服务。</div>
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
        {msg && (
          <p className={msg.kind === "ok" ? "ok-text" : "err"} style={{ gridColumn: "1/-1" }}>
            {msg.text}
          </p>
        )}

        <div className="card">
          <h2>Kaneo 连接</h2>
          <Field id="kb" label="API 地址（含或不含 /api 后缀）">
            {(ctl) => (
              <input
                {...ctl}
                value={kBaseUrl}
                onChange={(e) => setKBaseUrl(e.target.value)}
                placeholder="http://kaneo.local:1337"
              />
            )}
          </Field>
          <Field id="kc" label="Web 地址（任务链接基址，可留空=同 API 地址）">
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
              onClick={() =>
                run(async () => {
                  const r = await api.put("/api/admin/connection/kaneo", {
                    baseUrl: kBaseUrl,
                    clientUrl: kClientUrl || undefined,
                    ...(kApiKey ? { apiKey: kApiKey } : {}),
                  });
                  setKApiKey("");
                  const kk = await api.get<KaneoGet>("/api/admin/connection/kaneo");
                  setK(kk);
                  return r;
                }, "Kaneo 配置已保存")
              }
            >
              保存
            </button>
          </div>
          <hr className="sep" />
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <Field id="tp" label="测试用项目 id">
                {(ctl) => <input {...ctl} value={testProjectId} onChange={(e) => setTestProjectId(e.target.value)} />}
              </Field>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy || !testProjectId}
              onClick={() =>
                run(() => api.post("/api/admin/connection/kaneo/test", { projectId: testProjectId }), "连通正常")
              }
              style={{ marginTop: 22 }}
            >
              连接测试
            </button>
          </div>
        </div>

        <div className="card">
          <h2>AI（OpenAI 兼容）</h2>
          <Field id="ab" label="接口地址（Chat Completions 的基址）">
            {(ctl) => (
              <input
                {...ctl}
                value={aBaseUrl}
                onChange={(e) => setABaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            )}
          </Field>
          <Field id="am" label="模型">
            {(ctl) => (
              <input {...ctl} value={aModel} onChange={(e) => setAModel(e.target.value)} placeholder="gpt-4o-mini" />
            )}
          </Field>
          <Field id="ak" label={<>密钥 {a.apiKeySet && <span className="ok-text">（已保存，留空则不修改）</span>}</>}>
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
              onClick={() =>
                run(async () => {
                  const r = await api.put("/api/admin/connection/ai", {
                    baseUrl: aBaseUrl,
                    model: aModel,
                    ...(aApiKey ? { apiKey: aApiKey } : {}),
                  });
                  setAApiKey("");
                  const aa = await api.get<AiGet>("/api/admin/connection/ai");
                  setA(aa);
                  return r;
                }, "AI 配置已保存")
              }
            >
              保存
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => api.post("/api/admin/connection/ai/test"), "AI 连通正常")}
            >
              连接测试
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => api.post("/api/admin/connection/ai/test-vision"), "AI 图像识别测试正常")}
            >
              测试图像识别 (Vision)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
