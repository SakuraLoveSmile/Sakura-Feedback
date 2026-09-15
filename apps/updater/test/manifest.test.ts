import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkProtocolCompat,
  type FetchLike,
  ManifestError,
  type ManifestOutcome,
  ManifestSource,
  parseManifest,
} from "../src/manifest.ts";
import { DIGEST_A, makeClock, makeManifest, type Scaffold, scaffold } from "./helpers/fakes.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => fs.rm(root, { recursive: true, force: true })));
});

async function source(
  options: { imageName?: string; fetch?: FetchLike; withLocalManifest?: boolean } = {},
): Promise<{ source: ManifestSource; dirs: Scaffold }> {
  const dirs = await scaffold({ imageName: options.imageName ?? "feedback-service:local" });
  roots.push(dirs.root);
  const withLocalManifest = options.withLocalManifest ?? options.fetch === undefined;
  if (withLocalManifest) {
    await fs.writeFile(
      `${dirs.deployDir}/release-manifest.json`,
      JSON.stringify(makeManifest({}, options.imageName ?? "feedback-service:local")),
      { mode: 0o644 },
    );
  }
  const manifestSource = new ManifestSource(dirs.config, {
    fetchImpl: options.fetch,
    now: makeClock(),
  });
  return { source: manifestSource, dirs };
}

function okResponse(text: string): Awaited<ReturnType<FetchLike>> {
  return { ok: true, status: 200, text: async () => text };
}

describe("parseManifest", () => {
  it("接受冻结契约的完整清单", () => {
    const manifest = parseManifest(JSON.parse(JSON.stringify(makeManifest())));
    expect(manifest.version).toBe("0.3.0");
    expect(manifest.services.feedback.digest).toBe(DIGEST_A);
    expect(manifest.requiredUpdaterProtocol).toBe(1);
    expect(manifest.dbSchemaVersion).toBe(4);
  });

  it("拒绝缺失字段、非法 digest、渠道不符与不支持的清单版本", () => {
    const base = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>;
    const withoutProtocol = { ...base };
    delete withoutProtocol.requiredUpdaterProtocol;
    expect(() => parseManifest(withoutProtocol)).toThrow(/requiredUpdaterProtocol/);

    const badDigest = JSON.parse(JSON.stringify(makeManifest()));
    badDigest.services.feedback.digest = "sha256:xyz";
    expect(() => parseManifest(badDigest)).toThrow(ManifestError);

    const otherChannel = JSON.parse(JSON.stringify(makeManifest()));
    otherChannel.channel = "beta";
    expect(() => parseManifest(otherChannel, "stable")).toThrow(/渠道/);

    const futureManifest = JSON.parse(JSON.stringify(makeManifest()));
    futureManifest.manifestVersion = 2;
    expect(() => parseManifest(futureManifest)).toThrow(/清单版本不受支持/);
  });
});

describe("checkProtocolCompat", () => {
  it("协议高于本执行器时给出升级执行器的指引并且不自我更新", () => {
    const compat = checkProtocolCompat(makeManifest({ requiredUpdaterProtocol: 2 }), 1);
    expect(compat.compatible).toBe(false);
    expect(compat.guidance).toContain("更新执行器协议 v2");
    expect(compat.guidance).toContain("不会重建自己");
    expect(checkProtocolCompat(makeManifest(), 1).compatible).toBe(true);
  });
});

describe("ManifestSource", () => {
  it("优先读取部署目录内的本地清单", async () => {
    const { source: manifestSource, dirs } = await source();
    const outcome = await manifestSource.load("stable");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.source).toBe("local");
      expect(outcome.location).toBe(`${dirs.deployDir}/release-manifest.json`);
    }
  });

  it("本地清单非法时明确报错而不是静默回退", async () => {
    const dirs = await scaffold({ imageName: "feedback-service:local" });
    roots.push(dirs.root);
    await fs.writeFile(`${dirs.deployDir}/release-manifest.json`, "{ not json");
    const manifestSource = new ManifestSource(dirs.config);
    const outcome = await manifestSource.load("stable");
    expect(outcome.kind).toBe("invalid");
  });

  it("没有本地清单也没有远端地址时返回 missing", async () => {
    const dirs = await scaffold({ imageName: "feedback-service:local" });
    roots.push(dirs.root);
    const manifestSource = new ManifestSource(dirs.config);
    const outcome = await manifestSource.load("stable");
    expect(outcome.kind).toBe("missing");
  });

  it("从远端拉取并写缓存，远端失败时用缓存兜底", async () => {
    const payload = JSON.stringify(makeManifest({}, "ghcr.io/sakura/feedback"));
    let calls = 0;
    const successFetch: FetchLike = async () => {
      calls += 1;
      return okResponse(payload);
    };
    const first = await source({ imageName: "ghcr.io/sakura/feedback", fetch: successFetch, withLocalManifest: false });
    const firstOutcome = await first.source.load("stable");
    expect(firstOutcome.kind).toBe("ok");
    if (firstOutcome.kind === "ok") expect(firstOutcome.source).toBe("remote");
    expect(calls).toBe(1);

    const failingFetch: FetchLike = async () => {
      throw new Error("network down");
    };
    const second = new ManifestSource(first.dirs.config, { fetchImpl: failingFetch, now: makeClock() });
    const secondOutcome = await second.load("stable");
    expect(secondOutcome.kind).toBe("ok");
    if (secondOutcome.kind === "ok") {
      expect(secondOutcome.source).toBe("cache");
      expect(secondOutcome.note).toContain("network down");
    }
  });

  it("远端不可达且没有缓存时返回 unreachable", async () => {
    const failingFetch: FetchLike = async () => {
      throw new Error("boom");
    };
    const { source: manifestSource } = await source({
      imageName: "ghcr.io/sakura/feedback",
      fetch: failingFetch,
      withLocalManifest: false,
    });
    const outcome: ManifestOutcome = await manifestSource.load("stable");
    expect(outcome.kind).toBe("unreachable");
    if (outcome.kind === "unreachable") expect(outcome.url).toContain("github.com/sakura/feedback");
  });
});
