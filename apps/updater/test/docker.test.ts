import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { assertNotDestructive, DockerCli, DockerError, type SpawnImpl } from "../src/docker.ts";

const config = loadConfig({
  UPDATER_IMAGE_NAME: "feedback-service:local",
  UPDATER_DEPLOY_DIR: "/opt/1panel/docker/compose/feedback",
  UPDATER_CONTROL_DIR: "/opt/1panel/docker/compose/feedback/update-control",
  UPDATER_STATE_DIR: "/opt/1panel/docker/compose/feedback/update-control/state",
  UPDATER_TOKEN_FILE: "/opt/1panel/docker/compose/feedback/update-control/updater-token",
});

interface Recorded {
  binary: string;
  args: readonly string[];
  options: { shell: false; timeoutMs: number; maxBuffer: number };
}

function recorder(result: { stdout?: string; stderr?: string; exitCode?: number }): {
  spawn: SpawnImpl;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const spawn: SpawnImpl = async (binary, args, options) => {
    calls.push({ binary, args, options });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0 };
  };
  return { spawn, calls };
}

describe("DockerCli 调用约定", () => {
  it("所有调用都是参数数组 + shell:false，且 compose 只针对预配置项目与服务", async () => {
    const { spawn, calls } = recorder({ stdout: "abc123\n" });
    const cli = new DockerCli(config, { spawn });
    await cli.serviceContainerId();
    await cli.stopFeedback(30);
    await cli.startFeedback();
    await cli.pullImage("ghcr.io/x/y@sha256:aa");
    await cli.copyVolume("vol-old", "vol-new", "feedback-service:local");
    await cli.volumeEntries("vol-new", "feedback-service:local");
    await cli.execNode("cid", "console.log(1)", { DB_PATH: "/data/feedback.db" });

    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.binary).toBe("docker");
      expect(Array.isArray(call.args)).toBe(true);
      expect(call.options.shell).toBe(false);
    }
    expect(calls[0]?.args).toEqual([
      "ps",
      "-a",
      "--filter",
      "label=com.docker.compose.project=feedback",
      "--filter",
      "label=com.docker.compose.service=feedback",
      "--format",
      "{{.ID}}",
    ]);
    expect(calls[1]?.args).toEqual([
      "compose",
      "--env-file",
      config.envFile,
      "-f",
      config.composeFile,
      "--project-name",
      "feedback",
      "stop",
      "-t",
      "30",
      "feedback",
    ]);
    expect(calls[2]?.args).toEqual([
      "compose",
      "--env-file",
      config.envFile,
      "-f",
      config.composeFile,
      "--project-name",
      "feedback",
      "up",
      "-d",
      "--force-recreate",
      "--no-deps",
      "--pull",
      "never",
      "feedback",
    ]);
    // 辅助容器把卷挂到固定路径，命令本身是常量，没有拼接任何外部值进 shell
    expect(calls[4]?.args).toEqual([
      "run",
      "--rm",
      "--user",
      "0:0",
      "--entrypoint",
      "cp",
      "-v",
      "vol-old:/from:ro",
      "-v",
      "vol-new:/to",
      "feedback-service:local",
      "-a",
      "/from/.",
      "/to/",
    ]);
    // 执行器自身从未出现在任何 compose 目标里
    expect(calls.every((call) => !call.args.includes("updater"))).toBe(true);
  });

  it("可执行文件缺失与超时映射为明确失败，非零退出默认失败", async () => {
    const missing = new DockerCli(config, { binary: "definitely-not-a-real-docker-binary-xyz" });
    await expect(missing.pullImage("x")).rejects.toMatchObject({ kind: "missing_binary" });

    const failing = recorder({ exitCode: 3, stderr: "daemon hiccup" });
    const cli = new DockerCli(config, { spawn: failing.spawn });
    await expect(cli.startFeedback()).rejects.toBeInstanceOf(DockerError);
    await expect(cli.startFeedback()).rejects.toMatchObject({ kind: "non_zero", exitCode: 3 });
  });

  it("禁止破坏性命令（prune / rmi / 卷删除）", () => {
    expect(() => assertNotDestructive(["prune"])).toThrow(/破坏性/);
    expect(() => assertNotDestructive(["image", "rmi", "x"])).toThrow(/禁止删除镜像/);
    expect(() => assertNotDestructive(["system", "prune"])).toThrow(/system prune/);
    expect(() => assertNotDestructive(["rmi", "x"])).toThrow(/破坏性/);
    expect(() => assertNotDestructive(["volume", "rm", "v"])).toThrow(/禁止删除卷/);
    expect(() => assertNotDestructive(["volume", "create", "v"])).not.toThrow();
  });

  it("解析 image inspect、volume inspect 与 df/du 输出", async () => {
    const imageLine = JSON.stringify({
      Id: "sha256:deadbeef",
      RepoDigests: ["ghcr.io/x/y@sha256:aa"],
      Config: { Labels: { "org.opencontainers.image.version": "0.3.0" } },
    });
    const imageCli = new DockerCli(config, { spawn: recorder({ stdout: `${imageLine}\n` }).spawn });
    const info = await imageCli.imageInfo("ghcr.io/x/y@sha256:aa");
    expect(info.id).toBe("sha256:deadbeef");
    expect(info.digests).toEqual(["ghcr.io/x/y@sha256:aa"]);
    expect(info.labels["org.opencontainers.image.version"]).toBe("0.3.0");

    const volumeCli = new DockerCli(config, {
      spawn: recorder({ stdout: '{"Name":"feedback_feedback-data"}\n' }).spawn,
    });
    expect(await volumeCli.volumeInfo("feedback_feedback-data")).toEqual({
      exists: true,
      name: "feedback_feedback-data",
    });

    const missingVolume = new DockerCli(config, {
      spawn: recorder({ exitCode: 1, stderr: "Error response from daemon: get v: no such volume" }).spawn,
    });
    expect(await missingVolume.volumeInfo("v")).toEqual({ exists: false, name: null });

    const daemonDown = new DockerCli(config, {
      spawn: recorder({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" }).spawn,
    });
    await expect(daemonDown.volumeInfo("v")).rejects.toMatchObject({ kind: "non_zero" });

    const duCli = new DockerCli(config, { spawn: recorder({ stdout: "1234\t/from\n" }).spawn });
    expect(await duCli.volumeSizeKb("v", "img")).toBe(1234);

    const dfOutput =
      "Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 8153564 3988144 3729660 52% /\n";
    const dfCli = new DockerCli(config, { spawn: recorder({ stdout: dfOutput }).spawn });
    expect(await dfCli.volumeAvailableKb("v", "img")).toBe(3729660);

    const badDf = new DockerCli(config, { spawn: recorder({ stdout: "garbage\n" }).spawn });
    await expect(badDf.volumeAvailableKb("v", "img")).rejects.toMatchObject({ kind: "invalid_output" });
  });
});
