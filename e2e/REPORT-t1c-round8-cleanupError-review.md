# 审查说明（追加，不改写原始执行结果）

对象：第 8 轮最新一次真实运行 `runId=20260913-160501-06d38a`（2026-09-13 16:05）。
性质：**事后审查结论追加**。本文件不修改任何原始产物；原始执行结果保持原样。

## 1. 原始产物（保留未改，可逐字核对）

| 产物 | 路径 | 当时写入的结论 |
|---|---|---|
| 执行器报告 | `e2e/t1c-runs/current/report.json` | `verdict = "BLOCKED"` |
| 历史留档（第 4 行） | `e2e/t1c-runs/history.jsonl` | `"verdict": "BLOCKED"` |
| 阶段结果 | `~/Library/Containers/dev.example.feedbackExample/Data/Documents/t1c/20260913-160501-06d38a/phase1.json` | 见下方逐字引用 |

当时 `phase1.json` 的关键字段（逐字，未改写）：

```json
{
  "runId": "20260913-160501-06d38a",
  "phase": "1",
  "verdict": "blocked",
  "reason": "默认 Data Protection Keychain 不可写：缺少 entitlement （OSStatus -34018 / errSecMissingEntitlement）——需有效 Apple 签名身份 + Keychain Sharing 后执行默认存储验收",
  "cleanupError": "PlatformException(Unexpected security result code, Code: -34018, Message: A required entitlement is not present., -34018, null)",
  "cleanup": {}
}
```

## 2. 审查结论：该轮应归为 **FAIL（退出码 1）**，不是 BLOCKED

按第 9 轮起生效并已写入判定库（`e2e/t1c_executor_lib.py`）与两阶段 Dart 契约的既定规则：

1. **任何非空 `cleanupError` 一律 FAIL。** 该轮 `cleanupError` 非空
   （删除探针键时同样返回 -34018），清理并未完成，`cleanup` 还是空对象
   `{}`，`probeCleared` 证据缺失。清理失败不得被 BLOCKED 掩盖。
2. 即使主错误确为可识别的 `-34018`（errSecMissingEntitlement），
   只要清理失败，整体就是 FAIL —— 阻塞分类只保证「错误被正确识别」，
   不豁免「本轮必须收尾干净」。
3. 该轮 `verdict` 写作小写 `"blocked"`，不符合线上大写契约
   （`PASS` / `FAIL` / `BLOCKED`）；第 9 轮判定库对小写一律判 FAIL。
4. 该轮从未给出「本轮从未写出令牌、无残留」的证明，因此也不能按
   「可证明无残留」路径记录清理完成 —— 无法证明就不能推断。

因此：**原始执行结果保留（BLOCKED），但按既定规则该轮的真实结论应为
FAIL / 退出码 1**。此更正不追溯改写产物，只在记录中标注。

## 3. 签名阻塞原因（照旧成立，未被上述更正否定）

- `security find-identity -v -p codesigning` → `0 valid identities found`；
- 构建产物为 ad-hoc 签名：`Identifier=dev.example.feedbackExample`、
  `TeamIdentifier=not set`；
- 运行时实测：默认 Data Protection Keychain 写入返回
  `OSStatus -34018 / errSecMissingEntitlement`。

即：本轮无法完成默认安全存储验收的**根因**确实是缺少有效签名身份 +
Keychain Sharing；但这不改变「该轮清理失败、应判 FAIL」这一判定。

## 4. 同一条命令的修复后复跑（对照）

| runId | 结论 | 退出码 | 说明 |
|---|---|---|---|
| `20260913-160501-06d38a`（第 8 轮原文） | BLOCKED（**应更正为 FAIL**） | 2（**应为 1**） | 含非空 `cleanupError`、`cleanup={}`、verdict 小写 |
| `20260913-170708-682518`（第 9 轮首次复跑） | FAIL | 1 | 执行器自身收尾缺陷：服务停止无法确认（僵尸子进程），已定位并修复 |
| `20260913-170959-3bf10d`（第 9 轮修复后复跑） | BLOCKED | 2 | `verdict` 大写、`blockedCause=missing-entitlement`、`cleanupError` 缺失、`cleanup={"tokenCleared":true,"probeCleared":true}`，清理已确认完成 |
| `20260913-171407-0ff16e`（第 9 轮最终代码树复跑） | BLOCKED | 2 | 与上一轮一致，`serviceStopped=true`、无残留进程 |

对照可见：判定规则收紧后，同为签名阻塞的本机环境，只有**清理也被证明完成**
的那一轮才允许停在大写 BLOCKED。
