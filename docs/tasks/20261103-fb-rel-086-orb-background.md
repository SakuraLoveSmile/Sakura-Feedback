# Feedback 0.8.6：灵感球待机背景更新

- 项目 personal-feedback；任务 FB-REL-086；状态：待体验。
- 目标：Web / Flutter 灵感球完整、贴边与小把手可见时，背景随宿主切页和内容变化更新，不长期保留上一场景；通过适用检查后发布正式新版本。
- 基线：36f074b（含 v0.8.5）；工作树：/Users/sakurasep/Documents/Code/Project/Project Worktree/personal-feedback/20261103-fix-fb-rel-086-orb-background；分支：fix/20261103-fb-rel-086-orb-background。发布沿现有分支流程，不改写含用户未提交改动且已分叉的 main，不顺手合并此前全部发布分支。
- 授权：用户明确要求修复并发布新版本，包含本任务提交、推送分支/新标签、正式 Release 与其配套构建；生产部署与升级其他宿主未包含在本次指令中。当前远端 Latest 为 v0.8.5，候选版本为 0.8.6；打标签前重新核对冲突。
- 现状：球内纹理来自已遮挡的宿主截图，只在首次可见等事件时捕获，同一可见期没有持续更新；待机唤醒可重用无限期旧图。0.8.5 隔离复现中背景蓝→绿，等 10 秒且唤醒仍蓝；改变 pageLabel 后才绿。

## 共享决定与验收

1. 复用已有带不透明敏感遮挡的采样链，不新增公共配置、依赖或未经遮挡的实时 backdrop。保持 v0.8.5 材质、布局、形变、待机隐藏/唤醒和正式截图行为。
2. 可见期间串行续采：一次成功捕获结束后间隔 250ms 再采下一帧（最多约 4 次/秒，重活不重叠、不排队累积）。这属于受限刷新，禁止逐动画帧执行完整截图。轮询覆盖没有 pageLabel/key 变化的换页、CSS/画布/宿主内容变化；实际表现需浏览器/渲染像素核验。
3. 失效事件（滚动、已知页面/身份/主题/尺寸变化）立即废弃旧装饰纹理，按受限节奏合并重采（清空纹理不能绕过捕获间隔）；合并高频请求，旧 generation 不得覆盖新状态。贴边/把手待机与唤醒保持续采；隐藏待机、面板/选区/交接、后台/不可见、卸载不采。
4. 首次或续采失败立即清旧图并停止本轮自动续采，保留轮廓降级，避免在不可采样页面无限重试；后续显式恢复/刷新触发仍可重新尝试。正式截图草稿、元数据、附件与 provider 次数不受装饰刷新影响。
5. 验收：同窗口无滚动、不改页面标识/child key/type，将宿主蓝→绿，下一轮纹理像素应绿；连续变化可多次更新；贴边/把手待机→唤醒显示当前背景；敏感像素始终不透明遮挡；面板/隐藏/后台/销毁停止，失败停止，恢复重新采样，慢捕获单在途且无迟到旧帧覆盖。

## 执行分工

- T1 Web：worker 独占 packages/web/src/element.ts 与 packages/web/test/ 受影响测试，可新增仅本问题所需内部调度模块。复用 captureViewport/OrbLens；不改共享文档、版本、e2e 或 Flutter。自行完成，不再分派。
- T2 Flutter：worker 独占 flutter/feedback/lib/src/widget.dart、test_env* 的必要测试开关以及 flutter/feedback/test/ 受影响测试，可增加内部调度辅助。复用 _captureFrozen 与 generation/遮挡；不改 pubspec、共享文档、e2e 或 Web。自行完成，不再分派。
- T1/T2 同时基于以上契约工作，各自只运行本端检查，Flutter SDK 及其生成目录由 T2 独占，主 agent 在交回后才运行 Flutter 组合态检查。
- T3 主 agent：维护本记录、版本/接入文档/更新日志、浏览器回归夹具和真实浏览器核验，组织独立只读审查、最终组合态与发布/资产校验。端口与进程使用任务隔离资源，不连接生产 AI/Kaneo/数据库。

## 验证与发布记录

- 实现与本地适用验证已完成；正式 Release、远端流水线与下载资产核验将在发布后补记。
- 旧用例中“成功后永久不再捕获”和“滚动后不重采”与本次明确目标相冲突，需替换为受限串行更新与相关像素/生命周期断言；保留失败不自动重试、遮挡、隔离、草稿、冻结选区、身份与资源释放门槛，不删除/跳过适用检查。
- 收尾：仅本任务未合入约定目标则保留发布工作树并记录原因；不清理其他活跃工作树。证据位于当前聊天 visualization 目录下 orb-idle-background-fix/，记录候选源码与发布资产的对应关系。

## 本轮核验进展

- 初版 Web：680 项通过；整仓 Node typecheck/lint/build 与 server 455 项通过。管理页 lint 原有 specificity warning 与 bundle 大小提示仍存在，无新增门禁变更。
- 真实 Chrome 使用实际候选 UMD、真实 html2canvas 与 WebGL：初版 9/9 通过；无页面标识变化时蓝→绿纹理延迟约 253ms，完整球/小把手/贴边更新、面板暂停与恢复、隐藏暂停与恢复、遮挡像素、单克隆与卸载清理均通过。旧 0.8.5 bundle 在相同浏览器夹具里因不能跟随绿色背景而超时，先红证据与截图保留。
- 独立 reviewer 发现两项 P2，发布前必须修复并复核：连续滚动绕过采样间隔；Flutter 整窗正式捕获 pending 期间未暂停装饰采样。T1/T2 正在修正，浏览器追加 20×16ms 连续滚动频率检查，最终结果以修正后重跑为准。
- 发布契约 `e2e/check-release-notes.py` 2/2 通过；`uv run --no-project --with pyyaml python e2e/check-release-workflow.py` 51/51 通过。系统与随包 Python 没有 PyYAML，使用 uv 的隔离环境完成，未修改项目依赖。
- 本机 git fetch --tags 对旧 v0.1.0–v0.5.2 报本地/远端标签冲突，未强制覆盖；已单独以 ls-remote 核实 v0.8.5 peeled SHA=95e4a9c，v0.8.6 尚不存在。该历史冲突不影响新标签的单独推送。

## 最终组合态（发布候选，2026-11-03）

- 独立 reviewer 两项 P2 已逐项复核闭合，未发现新的发布阻断。Web 使用与纹理有效性无关的完成后截止时间，取消也不能绕过限频；Flutter 连续滚动复用有界调度，正式捕获 pending 时同步停采并使旧 generation 失效。
- Web：38 文件 **681 项**通过（基线 670，新增 11）；最终 typecheck/lint/build 通过。Flutter：`flutter analyze --no-pub` 无问题；`flutter test --no-pub --reporter expanded` **668 项**通过（基线 658，新增 10）。
- 主 agent 组合核验：整仓 Node typecheck/lint/build、server **455 项**通过；Flutter 示例 analyze 无问题、**38 项**通过。相关检查未连接生产数据库、AI 或 Kaneo；admin test 为原占位脚本，未将它当作管理页行为证据，本次未改管理页行为。
- 最终真实 Chrome 9/9：同页蓝→绿约 **289ms**；屏幕实际球心 RGBA **[2,253,2,255]**；完整球/handle/edge 跟随当前内容；连续 20×16ms 滚动只启动 **1** 个克隆（修复前同场景 **6** 个）；最大同时克隆 **1**；隐藏/面板暂停，恢复/卸载清理正确，17 个未滚动纹理帧均保留不透明敏感遮挡。实际候选 UMD hash 与结果在 `browser-final/results.json`。
- 额外 Flutter Web release 构建真实浏览器核验：固定 pageLabel、child key/type 不变，宿主内部 State 在 2 秒后蓝→绿；截图与屏幕像素确认球内更新为当前绿色，球区域无残留蓝色，pageErrors 为空；未复现早期尖刺里周期捕获丢背景的问题。使用仓库外一次性入口与静态 loopback 服务，未改正式示例逻辑；截图 `flutter-web-current-green.png` 与 `flutter-web-results.json`。
- 既有测试调整依据：把旧“永不续采 / 滚动后永久不采 / 1秒闸门”换成持续安全像素与有界次数；T7f-F 的一次 transient callback 已定位为新纹理触发的 LayoutBuilder 提交，补一帧后继续断言原尺寸、零 wobble、零 transient。未跳过测试或降低遮挡、草稿、provider、旧 generation、冻结选区、资源释放门槛。
- 限制：250ms 为成功捕获完成后的调度间隔，不能承诺逐显示帧同步；复杂真实宿主、Android/iOS 原生真机与移动 GPU 的长期功耗/帧性能未实测，未据简单色块结果外推。源码和 Web/Flutter 公共配置均无新增依赖，服务接口/schema14不变。
