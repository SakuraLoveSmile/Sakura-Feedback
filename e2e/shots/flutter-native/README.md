# flutter-native 验证证据索引（T3/T5 verifier）

本目录是本轮「Flutter 安全存储兼容（flutter_secure_storage 9/10/11）」原生验证的证据索引。
**本轮没有截图**：Android 验证在无窗口（`-no-window`）模拟器上完成，可视化流程图与数值证据是结构化
JSON / prefs dump / 退出码文件；截图对判断迁移是否破坏令牌没有增量信息，因此未产出（如实记录，不凑数）。

## 权威记录

- 结论与逐项说明：仓库根 `VERIFICATION.md` 的
  「## Flutter 安全存储兼容（flutter_secure_storage 9.2.2 / 10.3.1 / 11.0.0，2026-09-14 · 状态：待体验）」。

## 证据位置

| 类别 | 路径 |
| --- | --- |
| 契约 verify 命令退出码汇总 | `e2e/flutter_native/out/verify/exitcodes.tsv` |
| 组件单测（analyze+test，112 例） | `e2e/flutter_native/out/verify/feedback-analyze-and-test.txt` |
| 示例单测（37 例）/ APK 构建 / iOS 构建 | `e2e/flutter_native/out/verify/examples-*` |
| 静态核对（依赖 / 接口 / 存储键） | `e2e/flutter_native/out/native/static-checks.txt` |
| Android 9→10→11 迁移结果 | `e2e/flutter_native/out/native/android-mig-*.result.json` |
| Android 签名 / 安装态 / shared_prefs | `e2e/flutter_native/out/native/android-{signature,inspect,post-delete-prefs}.txt` |
| 异步落盘伪影的诊断与隔离实验 | `e2e/flutter_native/out/native/android-flush-attribution.txt`、`android-flush-*.result.json` |
| 测试数据清理（macOS 键 / Android 卸载） | `e2e/flutter_native/out/native/macos-cleanup.result.json`、`android-cleanup.txt` |
| 收敛前完成的 macOS Keychain 运行时（附录） | `e2e/flutter_native/out/native/macos-{write,read,delete,absent,denied-errorprobe}.result.json` |
| 收敛前完成的独立矩阵（附录） | `e2e/flutter_matrix/out/matrix-summary.tsv` |

## 复跑

```bash
export PATH="$HOME/flutter/bin:$PATH"

# 契约 verify 命令（分析+测试 / 构建 / 身份）
bash e2e/flutter_native/run_verify_commands.sh

# Android 9→10→11 迁移（需 JDK 17 + 已启动模拟器/真机）
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
bash e2e/flutter_native/run_native.sh android-migrate

# 测试数据清理（卸载测试应用 / 删除探针自己的 Keychain 键）
bash e2e/flutter_native/run_native.sh cleanup
```
