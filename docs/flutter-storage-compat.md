# Flutter 安全存储兼容：flutter_secure_storage 9 / 10 / 11

> **状态**：实现与验证已完成，等待用户体验确认。**本次未提交、未推送、未打标签（待授权）**——
> 因此本文件不包含任何本次产物的 commit SHA 或 tag 名（见第 7 节）。
>
> **权威验证记录**：[`VERIFICATION.md`](../VERIFICATION.md) 的
> 「## Flutter 安全存储兼容（flutter_secure_storage 9.2.2 / 10.3.1 / 11.0.0，2026-09-14 · 状态：待体验）」这一节。
> 下文写作 `§n` 的引用**全部**指该节内的小节号（§0 ~ §12），可逐条回查。
>
> 本文只写**已实测**或**明确标注为未做/未通过**的内容；凡是查不到证据的能力，一律不写。

---

## 1. 一句话结论

`feedback_widget`（[`flutter/feedback`](../flutter/feedback)）对 `flutter_secure_storage` 的约束从
`^9.2.2` 放宽为 **`'>=9.2.2 <12.0.0'`**（[`pubspec.yaml:20`](../flutter/feedback/pubspec.yaml)），
让同一份组件代码可以同时被固定在 **9.2.2 / 10.3.1 / 11.0.0** 的宿主使用。

- 组件代码**零改动**：`git diff -- flutter/feedback/lib` 输出 0 行，`FeedbackConfig`、
  `FeedbackTokenStore.read/write/clear`、`feedbackTokenStorageKey`、`FeedbackWidget`
  逐个与 HEAD 一致（§1、§3）。
- 组件只调用三版**共有**的 `read` / `write` / `delete`
  （[`lib/src/platform_io.dart:31/35/38`](../flutter/feedback/lib/src/platform_io.dart)），
  不用 `deleteAll` 或任何批量清除（§1）。
- 存储键与失败语义不变：`feedback_widget.bearer_token.<base64url(apiBase + "\u0000" + appId)>`；
  令牌写入失败仍提示「无法保存登录状态，请检查应用的安全存储配置」并保留草稿，
  **不回落内存 / 明文存储**（§1、§3；三档回归全绿）。

> ⚠️ 放宽约束**不会自动迁移数据**（见第 4 节），也不会改变任何已锁定旧版本的宿主。

---

## 2. 版本矩阵（实测）

数据来源：`tools/flutter-storage-matrix/out/matrix-summary.tsv` 与逐档 `out/<tier>/resolved.json`，
经 `VERIFICATION.md` §4 核对（表格逐项与产物一致）。

| 档位（固定版本） | 解析到的 `flutter_secure_storage` | `darwin` | `macos` | `windows` | `platform_interface` | `pub get` | `analyze` | `test` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **9.2.2** | 9.2.2 | 无 | **3.1.3**（走 `_macos`） | **3.1.2** | **1.1.2** | 0 | 0 | 0（116/116） |
| **10.3.1** | 10.3.1 | **0.3.2**（取代 `_macos`） | 不再出现 | **4.2.2** | **2.1.0** | 0 | 0 | 0（116/116） |
| **11.0.0** | 11.0.0 | **0.4.2**（取代 `_macos`） | 不再出现 | **4.2.2** | **2.1.0** | 0 | 0 | 0（116/116） |

三档都在 Dart 3.11.1 / Flutter 3.41.3 上跑，每档跑的是**同一份组件测试源码**
（`run.sh` 同步 `flutter/feedback/test` 并记录逐文件 sha256）。每档 116 例
= 组件包 112 例 + 矩阵宿主自身 4 例契约用例。

### 2.1 换包时点：**从 10.x 起**，不是 11 才有

| 变化 | 发生时点 | 证据 |
| --- | --- | --- |
| `flutter_secure_storage_darwin` 取代 `flutter_secure_storage_macos`（iOS/macOS 共用一份实现） | **10.x 起** | 9.2.2 档无 `darwin`、有 `_macos 3.1.3`；10.3.1 与 11.0.0 档都只有 `darwin`（0.3.2 / 0.4.2），`_macos` 消失（§4） |
| `flutter_secure_storage_windows` 主版本 3 → 4 | **10.x 起** | 9.2.2 档 `3.1.2`；10.3.1 与 11.0.0 档均 `4.2.2`（§4） |
| `flutter_secure_storage_platform_interface` 主版本 1 → 2 | **10.x 起** | 9.2.2 档 `1.1.2`；10.3.1 与 11.0.0 档均 `2.1.0`（§4） |

> 这一条是对早期假设的**实测修正**：换包与主版本跃迁都发生在 10.x 档，不是 11 才发生。
> 影响接入方：从 9 升到 10 就必须验证「iOS/macOS 实现包换名」，不要以为只在 11 才有差异。

### 2.2 证据强度（如实标注）

| 档位 | 本轮如何处理 | 强度 |
| --- | --- | --- |
| 9.2.2 | 收敛后未重跑矩阵，采信实现者（T1/T2）证据 | 采信实现者证据（§4 明确标注） |
| 10.3.1 | 逐项读过 `resolved.json` 复核（既非旧锁 9.2.4、也非新锁 11.0.0） | 已被验证者逐项核对（§4） |
| 11.0.0 | 收敛后未重跑矩阵，采信实现者证据 | 采信实现者证据（§4 明确标注） |

补充（**不作为本轮验收依据**，仅保留）：收敛前验证者另建独立宿主 `e2e/flutter_matrix` 独立复跑过三档
（三档 `analyze`/`test` 全 0、SUT 副本 sha256 与工作区一致），见 §11 附录。

---

## 3. 平台要求：组件与宿主的分工

### 3.1 本组件（`feedback_widget`）

| 项 | 值 | 依据 |
| --- | --- | --- |
| Dart SDK | `^3.6.0`（**未抬高**） | [`flutter/feedback/pubspec.yaml:6`](../flutter/feedback/pubspec.yaml)（§1、§3） |
| Flutter | `>=3.27.0`（**未抬高**） | 同上 `pubspec.yaml:7` |
| `flutter_secure_storage` | `'>=9.2.2 <12.0.0'` | `pubspec.yaml:20` |
| 支持的平台 | web、android、ios、windows、macos、linux（平台差异由条件导入隔离） | [`flutter/feedback/README.md`](../flutter/feedback/README.md) |

组件**不抬高**自己的最低 SDK：它只用三版共有的 API，所以旧宿主（Dart 3.6 / Flutter 3.27）继续可用。

### 3.2 使用 11 的宿主（硬要求）

固定到 `flutter_secure_storage 11.0.0` 的宿主**必须自行满足**下面三条——它们来自插件包自身的元数据，
不会被 `feedback_widget` 的约束替你满足：

| 要求 | 值 | 来源 |
| --- | --- | --- |
| Dart | `>=3.8.0` | 插件 `flutter_secure_storage-11.0.0/pubspec.yaml` 的 `environment.sdk`（经 pub cache 核实，见 `MUSIC-CONSTRAINTS.md` §2） |
| Android `minSdk` | `24` | `flutter_secure_storage-11.0.0/android/build.gradle:30` |
| Android `compileSdk` | **37** | `flutter_secure_storage-11.0.0/android/build.gradle:22` |

关键点：**Flutter 3.41.3 的默认 `compileSdk` 是 36，低于 37**
（`$HOME/flutter/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt:23`），
而插件的 Android 库模块以 `compileSdk 37` 编译，按 AGP 的 AAR metadata 规则消费方应用必须编译到 `>= 37`
（来源与推论逐条见 `tools/flutter-storage-matrix/MUSIC-CONSTRAINTS.md` §2、§3）。
所以**使用 11 的宿主必须显式写 `compileSdk = 37`**，不能沿用默认值；
示例这样配置后 `flutter build apk --debug` exit 0（§2 命令 3）。

> 10.3.1 档本次**未单独核实**插件自身的元数据下限。矩阵实测只证明：在 Dart 3.11.1、
> 示例工程的 `compileSdk 37` / `minSdk >= 24` 下，该档能解析、能通过分析与测试。
> 以 10.x 为目标的接入方请自行读该版本的 `pubspec.yaml` 与 `android/build.gradle`。

### 3.3 本仓库示例（`examples/flutter`，作为「使用 11 的宿主」）

[`examples/flutter`](../examples/flutter) 把 `flutter_secure_storage` 固定为 `'11.0.0'`，并已落实宿主义务：

- `android/app/build.gradle.kts`：`compileSdk = 37`、`minSdk = maxOf(flutter.minSdkVersion, 24)`。
- `macos/Flutter/GeneratedPluginRegistrant.swift`：`_macos` → `darwin`
  （不更新这个生成文件会导致 macOS 编译失败）。
- `ios/Podfile.lock` 与 `macos/Podfile.lock`：已由 CocoaPods 1.17.0 重新生成
  （`_macos 6.1.3` / `flutter_secure_storage 6.0.0` → 两处都是 `flutter_secure_storage_darwin (10.0.0)`），
  `SPEC CHECKSUM` 均为 `46e40169…`。
- `pubspec.lock` 与 `.flutter-plugins-dependencies` 已按 11.0.0 刷新。

> ⚠️ **易混淆点（按 pub 版本对照时必看）**：`Podfile.lock` 里的 **`10.0.0` 是 CocoaPods podspec 的版本**
> （`flutter_secure_storage_darwin-0.4.2/darwin/flutter_secure_storage_darwin.podspec:6` 的 `s.version = '10.0.0'`），
> 而**这个 pub 包的版本是 `0.4.2`**。两个数字不同来源，不要混用，也不要据此以为装了另一个包。

### 3.4 Music（sakuramusic）的记录

以下摘自本仓库 `tools/flutter-storage-matrix/MUSIC-CONSTRAINTS.md`（每条都带文件与行号来源），
**属于 Music 仓库，不在本次改动范围内**，仅作为接入方对照记录：

| 事实 | 来源 |
| --- | --- |
| Music 声明 `flutter_secure_storage: ^11.0.0`，解析到 `11.0.0` | `Music/pubspec.yaml:71`、`Music/pubspec.lock:414-419` |
| Music 自身 Dart 下限 `sdk: ^3.11.1`（已满足插件的 `>=3.8.0`） | `Music/pubspec.yaml:25` |
| Music **没有**显式写 `compileSdk` / `minSdk`，直接继承 `flutter.compileSdkVersion` / `flutter.minSdkVersion` | `Music/android/app/build.gradle.kts:12`、`:56` |
| Flutter 3.41.3 的默认值是 `compileSdkVersion = 36`、`minSdkVersion = 24` | `$HOME/flutter/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt:23/26` |

→ **结论（有来源、非猜测）**：Music 用 `^11.0.0` 且继承 `flutter.compileSdkVersion`
（Flutter 3.41.3 上为 **36**），因此 **Music 自身也需要显式 `compileSdk = 37`** 才能在该 Flutter 版本上构建 Android；
`minSdk` 继承到的 24 恰好满足插件下限。该结论由 Music 仓库自行处理，本组不代改。

---

## 4. 迁移边界（接入方必读）

1. **放宽版本范围不会自动迁移数据。** 本次只改了解析约束：`flutter pub get` 不会搬运任何已存条目，
   插件也不会在首次读取时把旧后端的值复制到新后端。
   - **Android 已实测可迁移**：同一 `applicationId` + 同一 debug 签名下逐档 `adb install -r`，
     9 档写入的令牌在 10 档读回成功、10 档写入的在 11 档读回成功（§6）。
   - **macOS / iOS 本次未做 Keychain 运行时验证**（只做到构建通过，§7、§10.1）——
     因此本文件**不声称** darwin 换包后旧 Keychain 条目一定可读，接入方必须在自己宿主的签名环境中自行验证。
   - **Windows / Linux 不在本次范围**，未尝试、未建阻塞条目（§0、§10.3）。
2. **旧宿主维持自己的锁定版本。** 已经提交了 `pubspec.lock` 的宿主，`pub get` 会继续解析到原版本；
   区间约束不会把它自动推向大版本。**不需要**为了本次变更升级任何旧宿主。
3. **不能直接从 9 跳到 11。** 平台实现包在 10.x 就换了一轮（`_macos` → `darwin`，
   `windows` 3.x → 4.x，`platform_interface` 1.x → 2.x，见第 2.1 节），
   而本次实测走的路径是 9 → 10 → 11 逐档升级安装。宿主若从 9 起跳，请逐档验证，不要一次跨两档。
4. **本次不自动升级其他已接入应用。** 只放宽 `feedback_widget` 的约束；其他宿主是否升级、
   何时升级由各自仓库决定。
5. **不要求升级 Feedback 服务端。** 本次不改服务端，HTTP 契约与组件调用方式未变（`lib` 零 diff，§1、§3）。
6. **不新增日志附件。** 本次不新增任何日志上报或附件抓取；截图与提交载荷字段未改（`lib` 零 diff）。
7. **不改变独立登录方式。** 面板内登录（不打开任何窗口）、`clientLabel`、`Authorization: Bearer`、
   401 按认证世代条件清除、令牌按服务身份分槽——全部保持原样（`lib` 零 diff，§1、§3）。
8. **不迁移 Music 现有凭据。** 本次不读写、不迁移、不删除 Music 侧任何凭据；
   本组只在自己仓库内做约束与文档改动。组件在原生端清理时**只动自己那一格**
   （键由 `apiBase` + `appId` 派生），宿主凭据共存已由单测与 Android 实机双重印证（§6、§11）。

---

## 5. 迁移步骤（宿主侧）

```bash
export PATH="$HOME/flutter/bin:$PATH"      # 本机 Flutter 不在 PATH

# 步骤 1：先看清宿主自己的平台下限
#   - Dart 是否满足目标档的插件要求（11 档为 >=3.8.0）
#   - Android：显式 compileSdk = 37、minSdk >= 24（11 档）
#   - iOS/macOS：签名与 Keychain entitlement 是否具备（本次未验证，必须自测）
```

1. **逐档切换，不跳档**：先把宿主固定到 **10.3.1**（`flutter_secure_storage: '10.3.1'`），
   `flutter pub get`，确认解析结果与第 2 节表格一致；跑通自己的「登录写入 → 重启/升级读回 → 登出删除」。
2. **再切到 11.0.0**：改约束 → `pub get` → 复核 `darwin` 存在、`_macos` 消失；
   Android 构建前确认 `compileSdk 37` 已显式写入。
3. **验证真实迁移路径**（不要把单测当迁移证据）：
   - Android：用**同 applicationId + 同签名**的 `adb install -r` 覆盖安装，而不是 `flutter run`
     （`flutter test` 结束会卸载应用，跨档数据留不下来，§6 记录了为什么改用 APK 升级安装）。
     升级前阶段写入 → 升级后读回 → 登出删除 → **独立进程**复核确实读不到。
   - macOS / iOS：必须在有正确签名与 `keychain-access-groups` 的真实目标上跑一次
     写 → 进程重启读 → 删 → 独立进程 absent（本次没做，§7、§10.1；反例表现见 §11 附录的 `-34018`）。
4. **回滚预案**：把宿主的 `pubspec.lock` 与约束改回原档并重新 `pub get`；
   注意**已经发生的数据迁移不会自动回退**，回滚前先确认旧后端里是否还有可用条目。
5. **测试写存储时的坑（§6 末、§8-F3）**：Android 的 `SharedPreferences.Editor.apply()` 是异步落盘，
   写完/删完立刻杀进程可能还没刷盘，看起来像「写入丢了」。写存储的测试请在退出前留时间并复读确认。

---

## 6. 验证范围与结论（如实标注）

本轮（t5）的收敛范围与结果（逐条对应 `VERIFICATION.md` 小节）：

| 项目 | 是否做 | 结果 | 依据 |
| --- | --- | --- | --- |
| 静态核对（依赖 / 接口 / 存储键） | 做 | 通过：`lib` 零 diff；全仓无真实依赖覆盖声明，且由矩阵逐档断言（`check_tier.py` 的「禁用依赖覆盖」一项）；契约字面命令现已真实通过（§8-F1 由后续修复任务 t7 闭环，收口复核见 §13） | §1、§3 |
| 三档解析结论核对 | 只读证据核对（不重跑矩阵） | 通过：见第 2.2 节的强度标注 | §4 |
| 组件包门禁 | 做 | `flutter analyze` exit 0；`flutter test` **112/112** exit 0 | §2 命令 1 |
| 示例门禁与构建 | 做 | 示例 `flutter test` **37/37** exit 0；`build apk --debug` exit 0；`build macos --release` exit 0（43.2MB）；`build ios --no-codesign` exit 0（16.9MB） | §2 命令 2~5 |
| **Android 9→10→11 迁移实测** | 做（本任务唯一重型项） | **全 PASS**（真实模拟器 android-35 + 真实 APK，同 applicationId / 同签名逐档 `adb install -r`） | §6 |
| macOS Keychain 运行时 | **未做** | **未做 Keychain 运行时验证**（按收敛范围只做构建） | §7、§10.1 |
| iOS Keychain 运行时 | **未做 / 判定未通过** | 本机无 iOS 模拟器运行时、无 iOS 真机描述文件，**判定为未通过/未做**，不虚构 Team、不清理用户 Keychain | §10.2 |
| Windows / Linux | **不做** | 不在本次范围；未尝试、未建任何阻塞条目 | §0、§10.3 |
| Android 真机 | 未做 | 验证在模拟器上完成，未使用真机 | §10.4 |

Android 迁移实测的具体阶段（全部 `verdict=PASS`，§6）：9 档写入并复读 → 10 档读回 9 档令牌 →
10 档写入自己的令牌 → 11 档读回 10 档令牌 → 11 档删除 → 独立进程复核为 `null` →
11 档一轮内写/读/删 → 删除后独立进程复核。同时：

- **宿主凭据共存**：上表每个阶段，模拟的音乐服务器密码与第三方令牌始终可读（§6）——
  组件登出/401 清理只动自己那一格，与单测 `host_credential_coexistence_test.dart` 互相印证。
- **无明文回退**：探针在应用数据目录内扫描令牌字面量，各阶段 `plaintext.hits=[]`；
  `shared_prefs/FlutterSecureStorage.xml` 中令牌以密文出现，删除后不再含 Feedback 槽位（§6）。
- **测试数据清理**：macOS 探针键与容器、Android 测试应用均已清除（未接触用户真实凭据，§9）。

**不属于本轮验收依据、仅保留的附录**（§11）：收敛前验证者自建的独立矩阵复跑（三档全绿）、
以及 macOS Keychain 真实运行时（Apple Development 签名 + `keychain-access-groups`：
write → 进程重启读 → delete → 独立进程 absent 全 PASS；无 entitlement 的 ad-hoc 变体复现
`PlatformException` `-34018`「A required entitlement is not present」，且读取返回 `null`、无明文回退）。

---

## 7. 交付信息（待提交清单、建议提交信息、Music 固定引用）

### 7.1 授权状态

**本次未提交、未推送、未打标签、未发布。** 下面的清单与提交信息是**建议**，需用户授权后执行。
本文件**不填任何 SHA**：产物还没有对应的提交，当前仓库的 HEAD 是**改动前的基线**，
不能当作本次产物的引用（§1）。

### 7.2 待提交文件清单（仅本次变更集）

> ⚠️ 工作区还有大量**与本变更无关**的未提交改动（服务端 / 管理页 / 部署 / 发布流水线等）。
> 提交本变更集时应只暂存下面列出的路径，不要把它们混进同一个提交。

**组件实现与测试**

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| `flutter/feedback/pubspec.yaml` | M | 约束一行 `'>=9.2.2 <12.0.0'` + 3 行说明注释；`environment` 未动 |
| `flutter/feedback/test/host_credential_coexistence_test.dart` | A | 新增 4 例：宿主凭据共存，不越界清理 |
| `flutter/feedback/test/token_store_scope_test.dart` | M | +32 行：令牌读/写/删除往返、重复删除幂等 |

**示例（作为「使用 11 的宿主」）**

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| `examples/flutter/pubspec.yaml` | M | 固定 `flutter_secure_storage: '11.0.0'` + 注释（切档方式） |
| `examples/flutter/pubspec.lock` | M | 9.2.4 → 11.0.0 刷新（锁文件，工具生成） |
| `examples/flutter/macos/Flutter/GeneratedPluginRegistrant.swift` | M | 工具生成：`_macos` → `darwin`（不更新 macOS 编译失败） |
| `examples/flutter/ios/Podfile.lock` | M | CocoaPods 1.17.0 重新生成：`flutter_secure_storage (6.0.0)` → `flutter_secure_storage_darwin (10.0.0)` |
| `examples/flutter/macos/Podfile.lock` | M | 同上：`_macos (6.1.3)` → `flutter_secure_storage_darwin (10.0.0)`（lock 里的 10.0.0 是 podspec 版本，pub 版本是 0.4.2） |
| `examples/flutter/android/app/build.gradle.kts` | M | `compileSdk = 37`、`minSdk = maxOf(flutter.minSdkVersion, 24)` |
| `examples/flutter/.flutter-plugins-dependencies` | 生成物 | 被仓库根 `.gitignore` 忽略，**不入库** |

**矩阵与 CI**

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| `tools/flutter-storage-matrix/` | A | 三档隔离矩阵宿主（`run.sh` / `check_tier.py` / `MUSIC-CONSTRAINTS.md` / `README.md` 等）。`out/`、`pubspec.lock`、同步进来的 `test/feedback/` 由该目录 `.gitignore` 排除，不入库 |
| `.github/workflows/ci.yml` | M | 新增 `flutter-storage-matrix` job（9.2.2 / 10.3.1 / 11.0.0 三档并行，任一档失败即失败） |

**文档与验证记录**

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| `docs/flutter-storage-compat.md` | A | 本文件 |
| `docs/integration.md` | M | 新增 Flutter 安全存储兼容小节 + 能力表行 + 相关文档条目 |
| `flutter/feedback/README.md` | M | 新增版本兼容与平台要求小节 |
| `examples/flutter/README.md` | M | 示例固定 11.0.0 的原因与 Android 配置备注 |
| `VERIFICATION.md` | M | 本轮验证小节（§0~§12 由验证者撰写）；**§13** 交付收口复核由本任务（t6）追加，明确标注为非验证者观测 |

**可选：验证证据（是否入库由用户决定）**

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| `e2e/flutter_native/`（脚本 + `out/`） | A | `run_native.sh` / `run_verify_commands.sh` / `keychain_probe` 源码 + `out/` 结构化证据（约 372KB）。**`e2e/flutter_native/work/` 是 8.2G 构建产物，绝不能入库**；当前该目录没有 `.gitignore` 兜底，提交前必须先排除它（该修复不在本任务 inScope，列为待办） |
| `e2e/flutter_matrix/`（脚本 + `out/`） | A | 收敛前独立矩阵复跑的证据（附录 §11）。同样需排除 `work/` 与构建产物 |
| `e2e/shots/flutter-native/README.md` | A | 证据索引（本轮无截图，已如实说明） |

### 7.3 建议提交信息

```text
feat(flutter): 兼容 flutter_secure_storage 9/10/11

- flutter/feedback: 约束 ^9.2.2 → '>=9.2.2 <12.0.0'，只使用三版共有的
  read/write/delete；接口、存储键与写入失败语义不变（lib 零 diff）
- 新增 tools/flutter-storage-matrix：9.2.2 / 10.3.1 / 11.0.0 三档隔离矩阵，
  每档 analyze + test 全绿（只用普通版本约束固定，不使用依赖覆盖）
- 补测试：宿主凭据共存 4 例 + 令牌读写删除往返与幂等
- 示例固定 flutter_secure_storage 11.0.0，Android 显式 compileSdk 37 /
  minSdk >= 24；刷新 pubspec.lock、Podfile.lock 与 macOS 插件注册
  （_macos → darwin）
- CI 新增三版本回归矩阵 job
- 文档：新增 docs/flutter-storage-compat.md，更新接入文档与两处 README
```

（仓库现有提交风格为 `feat: …` / `fix: …` 单行主题 + 要点正文，上面按同样风格起草。）

### 7.4 推送后可用于 Music 固定的引用形式

`feedback_widget` 声明了 `publish_to: none`（不发布到 pub.dev），跨仓库引用只能走 **Git**。
推送并发布后，Music 侧可用两种等价形式固定：

```yaml
# 形式 A（推荐）：语义化版本标签
dependencies:
  feedback_widget:
    git:
      url: git@github.com:SakuraLoveSmile/Sakura-Feedback.git
      ref: vX.Y.Z            # 实际发布的标签，由 docs/release.md 的流水线产出
      path: flutter/feedback

# 形式 B（不可变）：固定 commit sha
dependencies:
  feedback_widget:
    git:
      url: git@github.com:SakuraLoveSmile/Sakura-Feedback.git
      ref: <40 位 commit sha，用下面命令取>
      path: flutter/feedback
```

获取方式（推送后执行，**本文件不预先填写结果**）：

```bash
git rev-parse 'vX.Y.Z^{commit}'    # 标签 → commit sha
# 或： git rev-parse <分支/标签>^{commit}
```

- 文件模板与 SSH / HTTPS 回退写法见 [`docs/integration.md` §2.4](integration.md)（已实测跑通过该形式）。
- 现有标签只有 `v0.1.0`、`v0.2.0`；根 `package.json` 的 `version` 是 `0.3.0`。
  **下一个标签名以实际发布为准**，本文件不预设版本号、不填 SHA。
- 任何情况下都不要用分支名做 `ref`（避免「昨天能编、今天不能编」）。

---

## 8. 复现命令

```bash
export PATH="$HOME/flutter/bin:$PATH"      # 本机 Flutter 在 $HOME/flutter，不在 PATH

# a) 组件包门禁（112 例）
cd flutter/feedback && flutter analyze && flutter test

# b) 三档隔离矩阵（约 5 分钟，需要联网解析 9.2.2 / 10.3.1）
bash tools/flutter-storage-matrix/run.sh 9.2.2 10.3.1 11.0.0
cat tools/flutter-storage-matrix/out/matrix-summary.tsv

# c) Android 9→10→11 迁移实测（需 JDK 17 + 已启动的模拟器/真机）
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
bash e2e/flutter_native/run_native.sh android-migrate
ls e2e/flutter_native/out/native/android-mig-*.result.json

# d) 构建（示例已固定 11.0.0）
cd examples/flutter && flutter build macos --release && flutter build ios --no-codesign && flutter build apk --debug
```

体验要点：c) 会在同一应用标识、同一 debug 签名上依次安装 9.2.2 → 10.3.1 → 11.0.0，
逐档产出 `verdict=PASS` 的结构化 JSON。**若某档 `verdict=FAIL`，说明该档切换真的破坏了已存令牌**——
这是这组验证最有价值的信号（§12）。

---

## 9. 证据索引（每条结论 → VERIFICATION.md 小节）

| 本文结论 | 证据位置 |
| --- | --- |
| 约束放宽为 `'>=9.2.2 <12.0.0'`、`environment` 未动、`lib` 零 diff、符号与 HEAD 一致 | `VERIFICATION.md` §1、§3 |
| 三档解析矩阵（含 9.2.2 无 darwin / 10.3.1 与 11.0.0 有 darwin） | §4（原始数据：`tools/flutter-storage-matrix/out/matrix-summary.tsv`、`out/<tier>/resolved.json`） |
| 「darwin 取代 `_macos`」「windows 3.x→4.x」「platform_interface 1.x→2.x」**从 10.x 起** | §4（与 `MUSIC-CONSTRAINTS.md` §2 一致） |
| 组件 112 例、示例 37 例、三种构建全部 exit 0 | §2 命令 1~5 |
| Android 9→10→11 迁移全 PASS、宿主凭据共存、无明文回退 | §6 |
| macOS / iOS **未做 Keychain 运行时验证**（仅构建） | §7、§10.1（iOS 另见 §10.2） |
| Windows / Linux 不在本次范围 | §0、§10.3 |
| 三档证据强度（9.2.2 / 11.0.0 采信实现者） | §4 末段 |
| 11 档宿主义务（Dart >=3.8 / minSdk 24 / compileSdk 37）与 Flutter 默认 36 | `MUSIC-CONSTRAINTS.md` §2~§4；§4 的 `check_tier.py` 断言 |
| Music 用 `^11.0.0`、继承 `flutter.compileSdkVersion`(36)、故自身也需显式 37 | `MUSIC-CONSTRAINTS.md` §1、§3 |
| 异步落盘伪影（写/删后立即杀进程可能未落盘） | §6 末段、§8-F3 |
| 收敛前的独立矩阵复跑与 macOS Keychain 运行时（附录，不作为验收依据） | §11 |
| F1（契约字面命令命中注释）与 F2（示例 `Podfile.lock` 未刷新）**已闭环**，及收口复核命令与结果 | §8-F1 / §8-F2（原始记录）+ **§13**（t6 收口复核，非验证者观测） |
| 全仓无真实依赖覆盖声明，且由矩阵 `check_tier.py` 逐档断言 | §3、§13；`tools/flutter-storage-matrix/check_tier.py` |

---

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [`VERIFICATION.md`](../VERIFICATION.md) | 权威验证记录与「未验证 / BLOCKED」清单 |
| [`docs/integration.md`](integration.md) | 完整接入指南（安装与版本固定、挂载、登录、失败处理） |
| [`flutter/feedback/README.md`](../flutter/feedback/README.md) | Flutter 包权威参考：API、遮挡、捕获会话、草稿与提交、登录、令牌存储键 |
| [`examples/flutter/README.md`](../examples/flutter/README.md) | 示例：挂载位置、第二路由与宿主对话框、平台构建备注 |
| [`tools/flutter-storage-matrix/README.md`](../tools/flutter-storage-matrix/README.md) | 三档隔离矩阵怎么跑、每档校验什么 |
| [`tools/flutter-storage-matrix/MUSIC-CONSTRAINTS.md`](../tools/flutter-storage-matrix/MUSIC-CONSTRAINTS.md) | 11 档约束的来源记录（含 Music 现状） |
