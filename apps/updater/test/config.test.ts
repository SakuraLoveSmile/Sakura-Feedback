import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_DEPLOY_DIR, deriveManifestUrl, loadConfig } from "../src/config.ts";

const baseEnv = {
  UPDATER_IMAGE_NAME: "ghcr.io/sakuralovesmile/sakura-feedback",
};

describe("loadConfig", () => {
  it("按冻结契约推导默认路径与监听地址", () => {
    const config = loadConfig({ ...baseEnv });
    expect(config.deployDir).toBe(DEFAULT_DEPLOY_DIR);
    expect(config.controlDir).toBe(path.join(DEFAULT_DEPLOY_DIR, "update-control"));
    expect(config.stateDir).toBe(path.join(DEFAULT_DEPLOY_DIR, "update-control", "state"));
    expect(config.tokenFile).toBe(path.join(DEFAULT_DEPLOY_DIR, "update-control", "updater-token"));
    expect(config.composeFile).toBe(path.join(DEFAULT_DEPLOY_DIR, "compose.yml"));
    expect(config.envFile).toBe(path.join(DEFAULT_DEPLOY_DIR, ".env.prod"));
    expect(config.composeProject).toBe("feedback");
    expect(config.service).toBe("feedback");
    expect(config.listenHost).toBe("0.0.0.0");
    expect(config.listenPort).toBe(8790);
    expect(config.protocolVersion).toBe(1);
  });

  it("缺失 UPDATER_IMAGE_NAME 直接拒绝启动", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/UPDATER_IMAGE_NAME/);
  });

  it("拒绝非绝对路径的部署目录", () => {
    expect(() => loadConfig({ ...baseEnv, UPDATER_DEPLOY_DIR: "relative/dir" })).toThrow(/绝对路径/);
  });

  it("拒绝把服务指向 updater 自身", () => {
    expect(() => loadConfig({ ...baseEnv, UPDATER_SERVICE: "updater" })).toThrow(/绝不重建自己/);
  });

  it("解析 UPDATER_LISTEN 的三种写法并校验端口", () => {
    expect(loadConfig({ ...baseEnv, UPDATER_LISTEN: ":9100" }).listenPort).toBe(9100);
    expect(loadConfig({ ...baseEnv, UPDATER_LISTEN: "127.0.0.1:9200" }).listenHost).toBe("127.0.0.1");
    expect(loadConfig({ ...baseEnv, UPDATER_LISTEN: "9300" }).listenPort).toBe(9300);
    expect(() => loadConfig({ ...baseEnv, UPDATER_LISTEN: "0.0.0.0:99999" })).toThrow(/端口无效/);
  });

  it("拒绝带 digest 的镜像名与非法协议版本", () => {
    expect(() => loadConfig({ UPDATER_IMAGE_NAME: "ghcr.io/a/b@sha256:aa" })).toThrow(/UPDATER_IMAGE_NAME/);
    expect(() => loadConfig({ ...baseEnv, UPDATER_PROTOCOL_VERSION: "0" })).toThrow(/UPDATER_PROTOCOL_VERSION/);
  });

  it("从 ghcr.io 命名空间推导清单地址，本地镜像标签没有远端清单", () => {
    expect(deriveManifestUrl("ghcr.io/sakuralovesmile/sakura-feedback")).toBe(
      "https://github.com/sakuralovesmile/sakura-feedback/releases/latest/download/release-manifest.json",
    );
    expect(deriveManifestUrl("feedback-service:local")).toBeNull();
    expect(loadConfig({ UPDATER_IMAGE_NAME: "feedback-service:local" }).manifestRemoteUrl).toBeNull();
  });
});
