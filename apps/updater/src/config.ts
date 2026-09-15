import path from "node:path";

/** 部署路径冻结契约：容器内外同绝对路径。默认值同时是 deploy/install-updater.sh 的默认值。 */
export const DEFAULT_DEPLOY_DIR = "/opt/1panel/docker/compose/feedback";
export const DEFAULT_CONTROL_DIRNAME = "update-control";
export const DEFAULT_COMPOSE_FILENAME = "compose.yml";
export const DEFAULT_ENV_FILENAME = ".env.prod";
export const DEFAULT_MANIFEST_FILENAME = "release-manifest.json";
export const DEFAULT_LISTEN = "0.0.0.0:8790";
export const DEFAULT_PROTOCOL_VERSION = 1;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface UpdaterConfig {
  listenHost: string;
  listenPort: number;
  composeFile: string;
  composeProject: string;
  service: string;
  deployDir: string;
  controlDir: string;
  stateDir: string;
  tokenFile: string;
  /** 控制目录内可选的第二份共享令牌（feedback 侧使用的 feedback-token）。 */
  feedbackTokenFile: string;
  imageName: string;
  protocolVersion: number;
  /** 部署环境文件（含反馈服务镜像与数据卷引用、主密钥）。 */
  envFile: string;
  composeConfigFile: string;
  pausedFile: string;
  releaseFile: string;
  tasksDir: string;
  backupsDir: string;
  manifestCacheFile: string;
  manifestLocalFiles: string[];
  manifestRemoteUrl: string | null;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:-]*$/;

function requireAbsolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new ConfigError(`环境变量 ${name} 必须是绝对路径（部署目录在容器内外保持一致），当前为 ${value}`);
  }
  return path.normalize(value);
}

function parseListen(raw: string): { host: string; port: number } {
  const text = raw.trim();
  const lastColon = text.lastIndexOf(":");
  let host = "0.0.0.0";
  let portText = text;
  if (lastColon >= 0) {
    host = text.slice(0, lastColon).trim() || "0.0.0.0";
    portText = text.slice(lastColon + 1).trim();
  }
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`环境变量 UPDATER_LISTEN 端口无效：${raw}`);
  }
  return { host, port };
}

/** 从镜像名推导 GitHub Releases 清单地址；非 ghcr.io 命名空间（例如本地构建标签）没有远端清单。 */
export function deriveManifestUrl(imageName: string): string | null {
  const match = /^ghcr\.io\/([a-z0-9._-]+)\/([a-z0-9._-]+)$/.exec(imageName);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}/releases/latest/download/${DEFAULT_MANIFEST_FILENAME}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UpdaterConfig {
  const imageName = (env.UPDATER_IMAGE_NAME ?? "").trim();
  if (!imageName) {
    throw new ConfigError("环境变量 UPDATER_IMAGE_NAME 缺失（例如 ghcr.io/sakuralovesmile/sakura-feedback）");
  }
  if (!IMAGE_PATTERN.test(imageName) || imageName.includes("@")) {
    throw new ConfigError(`环境变量 UPDATER_IMAGE_NAME 非法（不接受带 digest 或标签的引用）：${imageName}`);
  }

  const deployDir = requireAbsolute("UPDATER_DEPLOY_DIR", env.UPDATER_DEPLOY_DIR ?? DEFAULT_DEPLOY_DIR);
  const controlDir = requireAbsolute(
    "UPDATER_CONTROL_DIR",
    env.UPDATER_CONTROL_DIR ?? path.join(deployDir, DEFAULT_CONTROL_DIRNAME),
  );
  const stateDir = requireAbsolute("UPDATER_STATE_DIR", env.UPDATER_STATE_DIR ?? path.join(controlDir, "state"));
  const tokenFile = requireAbsolute(
    "UPDATER_TOKEN_FILE",
    env.UPDATER_TOKEN_FILE ?? path.join(controlDir, "updater-token"),
  );
  const composeFile = requireAbsolute(
    "UPDATER_COMPOSE_FILE",
    env.UPDATER_COMPOSE_FILE ?? path.join(deployDir, DEFAULT_COMPOSE_FILENAME),
  );

  const composeProject = (env.UPDATER_COMPOSE_PROJECT ?? "feedback").trim();
  if (!NAME_PATTERN.test(composeProject)) {
    throw new ConfigError(`环境变量 UPDATER_COMPOSE_PROJECT 非法：${composeProject}`);
  }
  const service = (env.UPDATER_SERVICE ?? "feedback").trim();
  if (!NAME_PATTERN.test(service)) {
    throw new ConfigError(`环境变量 UPDATER_SERVICE 非法：${service}`);
  }
  if (service === "updater" || composeProject === "updater") {
    throw new ConfigError("UPDATER_SERVICE/UPDATER_COMPOSE_PROJECT 不得指向 updater 自身：执行器绝不重建自己");
  }

  const protocolRaw = env.UPDATER_PROTOCOL_VERSION ?? String(DEFAULT_PROTOCOL_VERSION);
  const protocolVersion = Number(protocolRaw);
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new ConfigError(`环境变量 UPDATER_PROTOCOL_VERSION 非法：${protocolRaw}`);
  }

  const listen = parseListen(env.UPDATER_LISTEN ?? DEFAULT_LISTEN);

  return {
    listenHost: listen.host,
    listenPort: listen.port,
    composeFile,
    composeProject,
    service,
    deployDir,
    controlDir,
    stateDir,
    tokenFile,
    feedbackTokenFile: path.join(controlDir, "feedback-token"),
    imageName,
    protocolVersion,
    envFile: path.join(deployDir, DEFAULT_ENV_FILENAME),
    composeConfigFile: composeFile,
    pausedFile: path.join(controlDir, "paused"),
    releaseFile: path.join(controlDir, "release"),
    tasksDir: path.join(stateDir, "tasks"),
    backupsDir: path.join(stateDir, "backups"),
    manifestCacheFile: path.join(stateDir, "manifest-cache.json"),
    manifestLocalFiles: [
      path.join(deployDir, DEFAULT_MANIFEST_FILENAME),
      path.join(controlDir, DEFAULT_MANIFEST_FILENAME),
    ],
    manifestRemoteUrl: deriveManifestUrl(imageName),
  };
}
