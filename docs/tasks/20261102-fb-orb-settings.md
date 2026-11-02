# FB-HOST-ORB-001：宿主托管的灵感球设置并发布 0.8.4

- 项目 / 任务编号：personal-feedback / FB-HOST-ORB-001
- 状态：实现中
- 创建日期（Asia/Taipei）：2026-11-02
- 权威记录：本文件
- 主仓库 / 当前工作目录：`/Users/sakurasep/Documents/Code/Project/Personal Project/Feedback`
- 基线 / 分支 / 合入目标：`v0.8.3`（提交 `a1f1949`）/ `feat/20261102-fb-orb-settings`（沿用 0.8.x 发布分支模式，不自行改写 `main`）
- 工作树：`/Users/sakurasep/Documents/Code/Project/Project Worktree/personal-feedback/20261102-feat-fb-orb-settings`
- 当前 HEAD / 未提交差异：工作树未提交（组件 0.8.4 候选）

## 目标与范围

Music 客户端要把设置页的「显示反馈悬浮球」开关改成具体的悬浮球设置（待机样式
小把手 / 球体贴边 / 隐藏，以及唤醒手势 双指长按 / 三指上滑 / 双指双击）。这两项设置目前由
组件自己按宿主 `appId` 持久化，宿主没有公开接口读写，因此先在组件侧增加**宿主托管**
（host-controlled）能力并发布新组件版本 `0.8.4`；Music 侧的依赖升级与设置 UI 是另一任务。

覆盖：`FeedbackWidget` 新增可选参数与导出、内置设置的托管模式、测试、接入文档、CHANGELOG、
五个版本入口与示例锁文件、`v0.8.4` 正式发布。不覆盖：Music 宿主改动、服务端/管理端/Web
运行时行为（本版本无变化）、生产服务部署（0.8.4 无服务端变更，不部署）。

## 已确认决定

- **API 形态**：`FeedbackWidget` 增加 `orbIdleStyle` / `onOrbIdleStyleChanged` 与
  `wakeGestures` / `onWakeGesturesChanged`，与 `FeedbackPanel` 既有参数同名同义。提供取值时
  组件不再写自己的偏好，值由宿主保存；面板内改选回调宿主。只提供取值不提供回调时，面板内
  对应设置区隐藏（避免无效操作）。两个设置可独立托管，未传时保持 0.8.3 行为。
- **导出**：包入口新增 `FeedbackOrbIdleStyle`、`FeedbackWakeGesture`，供宿主设置 UI 使用。
- **兼容性**：纯增量、可选参数、默认关闭，旧宿主无需改动；数据库 schema 保持 14；Web 端无行为变化。
- **版本**：统一 **0.8.4**（patch，与 0.8.1/0.8.2/0.8.3 的兼容增量模式一致），发布标签 `v0.8.4`，
  走既有手动发布流水线；不发布到 pub.dev。
- 本地 Flutter 3.41.3 / Dart 3.11.1 与 CI 固定的 `flutter-version: 3.41.3` 一致。

## 实现与验收

| 步骤 | 用户效果 / 实现范围 | 验收情形与预期 | 当前结果及证据 | 状态 |
| --- | --- | --- | --- | --- |
| T1 | 宿主可托管待机样式与唤醒手势 | 未传参时行为与 0.8.3 一致（组件自存）；传值时按宿主值渲染、不写组件偏好、面板内改选回调宿主；`hidden` 立即隐藏入口、回传后恢复；只给值不给回调时设置区隐藏 | 组件 analyze 无问题；654 项测试通过（基线 648，新增 6 项）；示例 38 项与 analyze 通过 | 已完成 |
| T2 | 发布 0.8.4 | 标签触发手动发布流水线；Release 非预发布；SOURCE.txt/`release-manifest.json` 提交与标签一致；Flutter 标签可供宿主固定 | 待发布 | 未开始 |
| T3 | 文档与兼容说明 | 接入指南写明宿主托管用法、未传参兼容；CHANGELOG 记录 0.8.4 | 已更新 `docs/integration.md` §4.2.1/§5.3.2 与 `CHANGELOG.md` | 已完成 |

## 执行与验证记录

| 日期 | 代码版本 / 候选差异 | 环境与运行对象 | 命令或实际操作 | 结果 / 证据位置 |
| --- | --- | --- | --- | --- |
| 2026-11-02 | 工作树未提交（0.8.4） | macOS arm64，Flutter 3.41.3 / Dart 3.11.1 | `flutter pub get`、`flutter analyze`（`flutter/feedback`） | 依赖解析成功；`No issues found!` |
| 2026-11-02 | 同上 | 同上 | `flutter test`（`flutter/feedback`） | 654 项全部通过（含新增 `test/host_orb_settings_test.dart` 6 项） |
| 2026-11-02 | 同上 | 同上 | `flutter pub get`、`flutter analyze`、`flutter test`（`examples/flutter`） | 示例 analyze 无问题；38 项通过 |
| — | — | — | 三档 `flutter_secure_storage` 矩阵、Node 全量检查 | 未本地运行；由发布流水线的 CI 门禁执行 |
| — | — | — | 真实 Music 宿主接入 | 未运行；宿主任务另行验证 |

## 提交与集成

| 提交 | 行为变化与原因 | 验证 | 合并 / 发布情况 |
| --- | --- | --- | --- |
| 待定 | 组件新增宿主托管灵感球设置；文档/CHANGELOG/版本入口 0.8.4 | 本机 analyze + 654 项组件测试 + 38 项示例测试 | 待推送/发布 |

## 交付与恢复

- 体验入口和操作步骤：宿主传参后，在宿主设置页修改待机样式 / 唤醒手势即时生效；不传参时在
  反馈面板「设置 → 灵感球 / 唤醒方式」修改。
- 尚未完成 / 尚未验证：发布流水线全量 CI（Node、三档安全存储矩阵）；Music 宿主的真实设置页体验。
- 用户确认（明确确认后才改为已验收）：待体验。
- 下一步：发布 `v0.8.4` 并核验 Release；Music 任务升级依赖并实现设置 UI。
- 回退方式：不发布或回退宿主依赖到 `v0.8.3` 即可；0.8.4 无服务端/schema 变更，已发布对象不回改。
- 本任务 worktree 收尾：发布并核验后检查清理。
