# 灵感球放大镜光学复刻（T-L0A / T-L0B / T-L1）

- 记录时间：2026-10-29（+08:00），记录人：规划者
- 仓库：`Sakura-Feedback`；基线 `main` @ `404f7cf`（工作区干净，单 worktree）
- 设计契约：[docs/orb-spec.md](../orb-spec.md) 第 13 节（2026-10-29 新增，官方包参数）
- 范围：现有灵感球入口的**球体光学**（Web + Flutter）；不含锁屏、桌面图标、壁纸、状态栏、“我在听…”胶囊
- 实现阶段按 `AGENTS.md` 新建 worktree：`personal-feedback/20261029-feat-orb-lens-replica/`，分支 `feat/20261029-orb-lens-replica`，合入 `main`

## 1 目标与边界

**目标**

1. 以官方包（超级小爱 8.3.30.4420）的灵感球实现为参考，把球体从“清玻璃 + 径向白环 + 静态双极色散”升级为“折射 + 色散 + 边缘/发光”的放大镜材质。
2. 把官方参数写进 spec 第 13 节，作为两端实现与验收的共同目标。
3. Flutter 裁决一条可落地的透镜路线；Web 在无背景纹理能力下做视觉近似，并写清差异。

**非目标**

- 不改 56 / 84、七态语义、命中区、badge、`launcher-mode`、`releasePoint` / `capture.region`、面板与上报流程。
- 不做官方包的液体形变、侧边停靠、接触阴影、动态虹彩（列为后续，见 spec 13.4）。
- 不复制、提交或分发官方包的代码、着色器、图片、动画与反编译产物。
- 不改 HTTP API、DB；本次无后端任务。

## 2 官方取证结果（T-L0A / T-L0B）

**来源**：用户提供的官方安装包解压目录（仓库外，只读）。静态检查 dex、GLSL 与资源清单，未运行应用。

**已确认**

- 主体着色器：`intentional_ball_v2_main_frag`（折射/PBR）；发光/背景：`intentional_ball_v2_glow_frag`；另有 `_burst_frag`、`_bg_frag`、`intentional_ball_vert`。
- 主体采样 `samplerExternalOES uBg` + `uBgTransform`：读取**整屏背景纹理**；球内看到球外图标是折射，不是均匀放大。
- 三态小球 Lottie：`assets/float_orb/{listening,thinking,executing}`（80×80、60fps）；属于小尺寸状态动效，不是大球本体。
- 关键默认值（完整表见 spec 13.2）：`IOR = 5.17`、`Refraction = 1.31`、`Dispersion = 0.61`、`EdgeWidth = 1.73`、`LensConcave = 0.81`、`OuterLayerMix = 1.07`、`Glow = 0.4`、`Radius = 0.08`（直径 = 16% 视口高）。
- 交叉验证：`Radius = 0.08` × GIF 高 1387 → 直径 ≈ 222px，实测 ≈ 220px，吻合。
- 官方默认开启接触阴影（`ContactShadow = 1.16`、`Gain ≈ 0.205`、`Blur = 1.83`），与 spec 12.8 的“参考帧无可测投影”冲突；本次保留无投影，接触阴影只做 T-L1 对照。

**未确认 / 待复核**

- `Highlight`、`V2Iridescence`、`OuterLayerConcaveMix`、`SideDarken` 在构造中未赋值（默认 0），运行时可能被其他入口覆盖。
- `ContactShadowGain` 的运行时分支（0.205 或 0.164）由标志位选择，未确认默认分支。
- 设备/场景覆盖值未逐项核对；spec 13 只记录本版本默认值。

## 3 卡片状态

| 卡 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| T-L0A | 官方包取证：定位 main/glow/burst/bg shader、三态 Lottie、参数入口 | 已取证 | 本记录 §2；spec 13.1 |
| T-L0B | 官方参数表与几何换算，写入 spec 13 | 已取证 | spec 13.2–13.3 |
| T-L1 | Flutter 透镜实现路线裁决（本次修订） | 已验收（用户接受 C；产品化验证未做） | 本记录 §4、§8、§9 |
| T-L2 | 透镜常量与滚动角纯函数 | 已验收（commit `5b561f8`，独立复跑通过） | 本记录 §9.1 |
| T-L3 | Flutter 透镜层接入 | 待体验（`7f7509b` / `57abd4b` / `d78c6a2`；测试全绿，真机证据缺） | 本记录 §10、§11 |
| T-L4 | Flutter 月牙/内圈色散 | 待体验（`32f3de8`→`e4834a6`→`d2750e1`，色散 0.05R；400 例通过） | 本记录 §12–§14 |
| T-L5 | Web 月牙/内圈色散近似层 | 已并入 T-L6（不实现，理由见 §15） | spec 12.4、§15 |
| T-L6 | 文档与平台差异收口 | 文档部分完成，待 T-L7 后复查 | 本记录 §15 |
| T-L7 | 全量回归与截图证据 | 进行中（自动侧完成；真机帧时间/首捕获/锚点滞后待补） | 本记录 §16–§18 |
| T-L8 | 代码审查 | 已完成（可合并、无阻断；T-L8a `67bf794` 已修） | 本记录 §19、§20 |

## 4 T-L1（2026-10-29 修订）

### T-L1 · Flutter 透镜实现路线裁决

- **负责角色**：前端（Flutter）
- **目标**：以官方 main shader 的光学结构为基准，在三条路线中裁决一条默认路线与一条退化路线，产出可复现的对比数据；本卡不写产品代码。
- **前置依赖**：T-L0A / T-L0B（已完成）。spec 13.2 的参数表、13.3 的尺寸换算是本卡的输入。
- **改动范围**：临时 Flutter 工程或临时 test（仓库外），验证后删除；不修改 `flutter/feedback/lib`、`packages/web/src`；不提交基准脚本。
- **实现要点**：

  1. **路线 A｜单层矩阵近似**：圆形裁剪内 `BackdropFilter(ImageFilter.matrix)`，以球心为中心放大 `1/lensScale` 的源区；验证放大倍率、正立、无模糊、嵌在 `Transform`（stateScale / breath / 方向拉伸）内是否仍正确采样。
  2. **路线 B｜多层 backdrop 近似折射**：中心层放大、边缘层压缩采样（把球外内容拉进球缘），用径向遮罩混合；验证接缝、banding、边缘色散与帧时间。这是官方“折射采样”的无捕获近似。
  3. **路线 C｜捕获 + 片元着色器**：把宿主内容捕获为 `ui.Image`，移植官方 main shader 的核心（`refract(viewDir, normal, 1/effIor)`、`LensConcave` / `OuterLayerMix`、RGB 分通道采样、边缘/发光）；验证捕获时机（球出现 / 开始拖动 / 每 N 帧）、捕获耗时与持续帧时间。
  4. 三条路线都使用同一合成场景：文字 + 图标网格 + 竖条纹；固定 `flow = 0.25`、`breath = 0.5`，与现有出图矩阵一致。
  5. 平台至少覆盖：macOS、Android 模拟器、Flutter Web；记录 `flutter test` 软件渲染器是否可采样。

- **契约引用**：spec 13.2（光学默认值）、13.3（几何）、13.4（平台与例外）、13.5（能力矩阵）；§5 七态、§7.4 painter 入参、§10.1 自动断言。
- **验收标准**：

  - [ ] 一张决策表：A / B / C × 保真度 / 成本 / 平台支持 / 风险；
  - [ ] 每个路线一张同场景截图，与四张参考帧并排；截图只放仓库外；
  - [ ] 中心与球缘的采样倍率有数值（A 为常数；B/C 给出径向曲线）；
  - [ ] 色散 split（`B−R`）在 `1.04R / 1.12R / 1.25R` 的量级，对照 `Dispersion = 0.61` 与 §12.6.1 的实测口径；
  - [ ] 边缘亮度/宽度剖面，对照 `EdgeWidth = 1.73`、`LensConcave = 0.81`、`OuterLayerMix = 1.07`；
  - [ ] 捕获耗时（ms）与持续帧时间：持续帧 ≤ 16.7ms；捕获若超过一帧预算，必须给出“只在拖动开始捕获一次”的方案与代价；
  - [ ] 明确结论：一条默认路线 + 一条退化路线，写入 spec 13.5 / 13.6；
  - [ ] 临时文件已删除，`git status` 无残留。

- **测试要求**：普通 widget test（不新建专用基准 harness）；记录设备、系统与 Flutter 3.41.3；涉及捕获的路线另记隐私边界（本地捕获、不上传、不写盘）。
- **风险与回滚**：

  - 路线 C 的捕获可能掉帧或引入隐私争议；不可接受则退 B。
  - 路线 B 可能出现接缝/banding；不可接受则退 A，并在 spec / README 标注“非官方折射”。
  - 路线 A 与官方差异最大，只能在“成本/平台”优先时采用。
  - 任一临时实现失败都不影响现有球体；本卡不产生产品改动，回滚即删除临时文件。

- **预估**：3–4h。

## 5 风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 官方参数是着色器乘数，不是 CSS alpha / sRGB | 直接套值会过亮或色偏 | spec 13.4 已写明只作强度/色相目标；像素目标仍按 §12 |
| 官方默认接触阴影与 §12.8 冲突 | 视觉不一致 | 本次保留无投影；接触阴影只做 T-L1 对照 |
| 捕获路线掉帧 / 隐私争议 | 高 | T-L1 以帧时间与捕获时机裁决；不可行退多层近似 |
| 多层 backdrop 接缝 | 中 | T-L1 截图判定；不可行退单层矩阵 |
| 参考帧为酷安转录、有压缩 | 中 | 只作视觉对照；数值以官方包参数为准 |
| 官方资源/代码误入仓库 | 高 | T-L7 增加 `git status` / 敏感文件检查；公开文档不写本地路径 |

## 6 验证与证据

- 本记录与 spec 13 的改动为文档；未运行产品测试。
- T-L1 完成后补：决策表、三路线截图、帧时间、平台矩阵。
- 实现阶段完成后按 T-L7 执行 `flutter analyze` / `flutter test`、Web `test/typecheck/lint/build`、e2e 截图/动效/对比度/forced-colors。

## 7 待确认

- T-L1 的默认路线 C 依赖“球出现 / 开始拖动时做一次**本地**宿主内容捕获（不上传、不写盘）”。若你不接受该行为，产品默认改为 A（只有均匀放大，不做折射）。
- 官方液体形变、侧边停靠、接触阴影、动态虹彩是否列入后续任务；本次默认不做。

## 8 T-L1 结果（2026-10-29，前端回执）

**裁决**：Flutter 默认 **C（捕获 + 片元着色器，仅单次捕获）**，退化 **A（单层矩阵）**；**B 不进入产品实现**；周期捕获禁止。

| 路线 | 保真度 | 成本 | 平台 | 结论 |
| --- | --- | --- | --- | --- |
| A 单层矩阵 | 中低：清晰均匀放大 | 最低 | macOS / Android / Web / test 均可采样 | 退化路线 |
| B 多层 backdrop | 中：硬环有径向变化 | 4 次 backdrop | 硬环可运行；软径向遮罩在 test 中使中心退化到 1.0× | 不采用（接缝 / banding / 软遮罩兼容性） |
| C 捕获 + shader | 最高：中心放大、边缘压缩、RGB 分采样 | 单次捕获成本波动 | 三端单次均可；test 可采样 | 默认路线（待产品化验证） |

### 8.1 尖刺报告值（待产品化复测）

- A：中心条纹 `1.667–1.833×`（目标 1.7×，像素取整）；叠加 `stateScale + breath + 方向拉伸` 探针约 `1.75×`，正立、清晰。
- B 硬环可见倍率：`0–0.58R = 1.70`、`0.58–0.77R = 1.25`、`0.77–0.91R = 0.90`、`0.91–1.0R = 0.62`；分段边界可见接缝。
- C 径向表观倍率：`1.700 / 1.698 / 1.671 / 1.577 / 1.401 / 1.173 / 0.866`（`r/R = 0 / 0.25 / 0.50 / 0.70 / 0.85 / 0.95 / 1.0`）；球缘源采样约 `1.156R`。
- 公共球沿壳层 split：`1.04R = 71.6`、`1.12R = 113.4`、`1.25R = 68.2`、`1.50R = 13.8`、`1.80R = 0.4`；半高点约 `0.775R`。壳层三路线相同，不作为内核色散能力证明。
- 持续帧 P95：macOS `A 1.387 / B 1.707 / C 1.616` ms；Android 16 模拟器 `A 22.871 / B 22.779 / C 24.289` ms；Flutter Web `A 2.300 / B 2.500 / C 2.401` ms。
- 首次捕获：macOS `97.853ms`（预热后 4.6–10.4ms）；Android 一次成功运行 `158.249ms`，另一次首捕获报 `Invalid image dimensions`；Web 单次 `25.3ms`。

### 8.2 C 的落地约束

1. 只在球出现、拖动开始或宿主内容失效时捕获一次；**不做每 N 帧捕获**。
2. 新图未就绪时显示 A 或上一帧，避免首次 25–158ms 空白。
3. 首捕获失败需要有界重试；仍失败则保持 A。
4. 快照期间宿主滚动/动画会造成陈旧或错位，这是单次方案的主要视觉代价。
5. `ui.Image` 仅存在本地内存，旧图释放；不上传、不写原始捕获文件。

### 8.3 未验证 / 冲突

- **Android 模拟器三路线均未满足 16.7ms**，不能声称帧预算已验收；未外推真机。
- Android 首捕获存在波动（成功 158ms / 偶发 `Invalid image dimensions`）；有界重试尚未在设备上验证。
- Web 周期捕获会丢失宿主背景（视觉不通过）；单次捕获视觉正常。
- 设备端“拖动开始捕获”未验证；单次快照在宿主动态变化下的陈旧程度未量化。
- 对比度保持率 12.3.1、七态、命中区、badge 未在本尖刺中覆盖，留给 T-L3/T-L7。
- C 是独立实现的近似折射，**不是官方 shader 复刻**；B 的软遮罩失败是否只存在于测试渲染器，未定性。
- A 在尖刺中使用 `RawMagnifier` 只为复用其单层矩阵做法；产品 A 应直接使用 `BackdropFilter + ImageFilter.matrix`，不引入 Material 放大镜外壳。

### 8.4 对后续卡的影响

- **T-L3**：范围扩大为“C 单次捕获 + 片元着色器 + A 退化 + 首帧隐藏 + 有界重试”；新增一个 `.frag` 资产（无第三方依赖），并在真机验证首捕获与拖动开始捕获。
- **T-L2 / T-L4**：参数目标不变，按 spec 13.2 实现；T-L4 的壳层 split 以 `1.12R ≈ 113` 为量级目标。
- **T-L5**：Web 仍只做 CSS 近似，不做捕获。
- **T-L7**：追加真机帧时间、首捕获重试、拖动开始捕获、快照陈旧、对比度 12.3.1、七态/命中区/badge 回归。

## 9 用户裁决与 T-L2（2026-10-29）

- 用户接受 **C**：默认 C（单次捕获 + 片元着色器），A 为退化；**允许一次本地单次捕获**（不上传、不写盘）；B 不采用；禁止周期捕获。
- **T-L2 范围**：只加常量与纯函数 + 单测；不做 widget 集成、不做捕获、不写 shader。
- 文件：`flutter/feedback/lib/src/orb.dart`；新建 `flutter/feedback/test/orb_lens_test.dart`。
- 常量（C 的近似映射，产品默认；不是官方 shader）：
  - 中心倍率 `1.70`、边缘倍率 `0.866`；
  - 径向表 `r/R = 0 / 0.25 / 0.50 / 0.70 / 0.85 / 0.95 / 1.0` → `1.700 / 1.698 / 1.671 / 1.577 / 1.401 / 1.173 / 0.866`；
  - 球缘源点 `1/0.866 = 1.1547`（由 `r / M(r)` 在 `r=1` 得到，不单独造常量）；T-L1 报告写的 `1.156R` 是独立取整读数，与推导值差 `1.3e-3`，见 §9.1 裁决；
  - 滚动角因子 `1.0`（设计推断）。
- 纯函数：`orbLensMagnification(rNorm)`（clamp 0..1，表内线性插值）、`orbLensSourceOffset(rNorm)`（`r / M`）、`orbRollAngle(travelled, radius)`（`travelled / radius`，clamp 0..2π，`radius <= 0` 保护）。
- 验收：表内点 + 端点 + 中点（`r=0.5 → 1.671`）；M 单调不增；源点单调递增且 `r=1 → 1.1547`（`1/M(1)`，±1e-3）；滚动向量 `0 / R→1rad / 2πR→2π / 超出→clamp`；不新增 painter 字段、不改 `shouldRepaint`；`flutter analyze` + `flutter test`（3.41.3）。
- T-L3 才接捕获、shader、A 退化与首帧隐藏。

- **2026-10-29 派工记录**：T-L2 首次派工（团队前端成员）连续 3 次返回 HTTP 错误；用户要求重派后同一通道仍失败（累计 5 次）。改用**独立前端会话**（监督模式）派发同一份契约，已交付。

### 9.1 T-L2 结果（2026-10-29）

- 分支 / worktree：`feat/20261029-orb-lens-replica`，worktree `worktrees/personal-feedback/20261029-feat-orb-lens-replica/`，从 `main @ 404f7cf` 切出。
- commit：`5b561f8` `feat(orb): 固化透镜径向放大表与滚动角纯函数`；仅 `flutter/feedback/lib/src/orb.dart`（+65 行纯追加）与新建 `flutter/feedback/test/orb_lens_test.dart`（+155 行）。
- 环境：Flutter **3.41.3** / Dart 3.11.1（`~/flutter`，非 3.47.7）。
- 验证（规划者独立复跑，不只采信回执）：
  - `flutter analyze`：`No issues found!`
  - `flutter test test/orb_lens_test.dart`：**17 passed**
  - `flutter test` 全量：**384 passed**（既有 orb_painter / orb_geometry / orb_contrast / orb_animation / orb_state 未回归）
  - `git status`：主工作区仍只有两处文档 WIP；分支相对 main 只有上述两个文件。
- 实现：`kFeedbackOrbLensCenterScale = 1.70`、`kFeedbackOrbLensEdgeScale = 0.866`、`kFeedbackOrbRollFactor = 1.0`；`kFeedbackOrbLensSampleR/M` 七点；`orbLensMagnification` 先 clamp 再分段线性插值；`orbLensSourceOffset = r / M(r)`（r=0 直接返回 0）；`orbRollAngle` 对 `radius <= 0` 返回 0，结果 clamp 到 `[0, 2π]`。未新增 painter 字段、未改 `shouldRepaint`、未接捕获/shader。
- **口径裁决（1.156 vs 1.1547）**：契约同时要求表值 `M(1)=0.866`（1e-9）与源点 `1.156 ± 1e-3`，二者不能同时成立（`1/0.866 = 1.1547`，差 `1.27e-3`）。裁决为**保留测得表值 `0.866`、源点按 `r/M(r)` 推导**，目标记作 `1.1547`；`1.156` 视为报告里的取整读数。理由：表值是直接测量物，源点是导出量，不应为了凑导出值去改测量表；T-L3 只消费函数，接口不受影响。单测里把这一差值写成注释，没有放宽断言。
- 遗留：纯数值层，无渲染验证；T-L3 仍需处理首帧隐藏、有界重试、A 退化。

## 10 T-L3 细化（2026-10-29 批准开工）

用户批准「开始 T-L3」。按切片原则拆成两卡，**同一写入者串行**，同一分支两个 commit；T-L3b 不可行时停在上一条并留证据，不回退 T-L3a。

### T-L3a · A 路线透镜接入（先落地真实放大）

- **角色 / 前置**：前端；T-L2（`5b561f8`）。
- **改动范围**：`flutter/feedback/lib/src/widget.dart`（`_buildOrb`）；新建 `flutter/feedback/test/orb_lens_widget_test.dart`；必要时调整 `orb_shots_test.dart` 夹具。
- **实现要点**：
  1. 在 `orbBox` 的 `CustomPaint` **之下**叠一层 `BackdropFilter`，滤镜 `ImageFilter.matrix`，以球心为原点按 `kFeedbackOrbLensCenterScale` 放大；裁剪为玻璃圆。
  2. 透镜层的几何必须与 `OrbPainter.paint` 同构：`translate(center) → rotate(dragAngle) → scale(orbStretch(pull),1) → rotate(-dragAngle) → scale(unit*stateScale*breathFactor)`，圆半径 `28`（`kFeedbackOrbIdleDiameter/2`）。对齐误差 ≤1 逻辑像素。
  3. 无 blur；不改 `OrbPainter` 字段与 `shouldRepaint`；不改命中区、badge、焦点环、`AnimatedContainer` 尺寸。
  4. `hidden`、选区覆盖层（`_selectionCapture != null`）期间不挂透镜层；reduced-motion 只关滚动角，不关放大。
- **验收**：
  - 条纹背景 widget 测试：球心条纹周期 = 球外周期 × `1.70`（±5%）；若测试渲染器不能采样 backdrop，改为「层存在 + 参数断言」并在回执写明未自动验证，**不许写假断言**。
  - 对比度保持率 ≥0.85（新增 widget 级用例，沿用既有 `orb_contrast_test` 口径）。
  - 七态透镜层存在矩阵：idle / hover / pressed / focus-visible / dragging / releasing 有；hidden 无。
  - `flutter analyze` + `flutter test` 全绿。
- **风险**：Impeller 与测试渲染器对 matrix 滤镜支持不一致 → 层存在断言 + 设备截图双证据。

### T-L3b · C 路线：单次捕获 + 片元着色器

- **角色 / 前置**：前端；T-L3a 完成。
- **改动范围**：新增 `flutter/feedback/shaders/orb_lens.frag`；`flutter/feedback/pubspec.yaml` 增加 `flutter: shaders:`；`lib/src/widget.dart`；按需在 `lib/src/orb.dart` 追加透镜采样纯函数；新建 `test/orb_lens_shader_test.dart`；`examples/flutter/test/` 增加资源 bundling 断言。**不改 Web。**
- **捕获源**：复用 `_repaintBoundaryKey`（已包住宿主 child 的 `RepaintBoundary`），**不新增公开 API**。
- **触发（硬约束）**：球首次可见后 postFrame 一次；拖动开始一次；同一时刻最多一个在途捕获；两次捕获间隔 ≥1000ms；`hidden` 释放 `ui.Image`；**永不周期捕获**。
- **失败**：`toImage` 或 shader 失败 → 立即显示 A；2 帧后重试，最多 2 次；仍失败保持 A 直到下次触发。首帧图像未就绪时显示 A，不得空白。
- **着色器**：输入 `uBg`、`uCenter` / `uRadiusPx`（图像像素）、7 点径向表；`r/R > 1` 输出透明；按 `r / M(r)` 采样；无模糊；**不做 RGB 分通道色散**（留给后续卡）。
- **资源键**：根键 `shaders/orb_lens.frag` 与宿主键 `packages/feedback_widget/shaders/orb_lens.frag` 都要尝试，失败退化 A。
- **验收**：
  - 测试渲染器能编译 shader：断言球心倍率 `1.70`（±5%）、`r=1` 处倍率 <1.0；不可用时记录证据并降级为 bundling + 层存在断言。
  - `examples/flutter` 中 `rootBundle.load('packages/feedback_widget/shaders/orb_lens.frag')` 通过。
  - 失败注入：shader 加载抛错时仍有放大（A），无异常冒泡。
  - 全量 `flutter test` 全绿（≥384）。
- **风险**：包内 shader 在宿主端 bundling 失败 → 只保留 A，C 不启用，并在 spec 13.5 记录。

## 11 T-L3 结果（2026-10-29）

### T-L3a · A 路线（`7f7509b`）

- 文件：`flutter/feedback/lib/src/widget.dart`（+187/−12）、新建 `test/orb_lens_widget_test.dart`。
- 结构：`orbBox` 内改为 `Stack[透镜层, CustomPaint]`，透镜层为 `RepaintBoundary → IgnorePointer → ClipPath(玻璃圆) → BackdropFilter(ImageFilter.matrix)`；`G·S(1.70)·G⁻¹` 以球心为原点放大，`G` 与 painter 变换链逐项同构。
- 规格：无 blur；不改 painter 字段与 `shouldRepaint`；命中区/badge/焦点环不变；选区覆盖层期间不挂；hidden 时不构建入口。
- 独立复跑（规划者）：`flutter analyze` 无问题；`flutter test` **392 passed**；`examples/flutter` analyze 无问题、**38 passed**。
- 像素证据：条纹周期拟合倍率 **1.7000**，放大中心偏移 **≈0.25 逻辑像素**，相关系数 `0.9988`；同窗口 1.0× 对照为 `−0.0391`（证明不是“层在但没采样”）。对比度保持率 light `0.8636` / dark `0.8640`（门槛 0.85）。
- 变异验证（规划者亲自做）：把 `_orbLensFilter` 的 `zoom` 换成 `Matrix4.identity()` 后，条纹周期/对齐用例立即转红；已还原，worktree 干净。

### T-L3b · C 路线（`57abd4b`）

- 文件：新增 `shaders/orb_lens.frag`、`pubspec.yaml` 的 `flutter: shaders:`、`examples/flutter/test/orb_lens_asset_test.dart`、`test/orb_lens_shader_test.dart`；`widget.dart`（+401）；新增 `lib/src/test_env.dart`（条件导出测试开关）。
- 捕获源：复用 `_repaintBoundaryKey`，无新增公开 API；`toImage` 后按边界全局矩形与球盒锚点换算 `uOffset/uScale/uCenter/uRadiusPx`。
- 触发：首次可见 postFrame 一次；拖动开始一次；单在途；间隔 ≥1000ms（`DateTime` 闸门，重试不占闸门）；hidden 释放 `ui.Image` 与 `ValueNotifier`；**无 `Timer`**，重试用 `addPostFrameCallback` + `scheduleFrame` 两帧后执行，最多 2 次。捕获异常/着色器不可用立即退回 A，不冒泡。
- 着色器：七点表展开为分支（3.41.3 运行时 SkSL 拒绝文件作用域 `const` 数组下标）；`r/R > 1` 输出透明；按 `r/M(r)` 采样；无模糊、无 RGB 分通道色散。
- 证据：球心 `1.6875`、球缘环带 `0.1875`（<1.0）、圆外 alpha `0`；坐标换算球心左 10px 暗线落 `368.0`（理论 `367.7`）；宿主按 `packages/feedback_widget/...` 可加载并编译（`examples/flutter` 38 例含该断言）。
- 行为取舍（已接受）：一秒闸门内再次显示不补拍，保持 A 直到下一次合法触发（拖动开始）。
- 测试开关：`debugDisableOrbLensCapture`、`debugFailOrbLensShader`（`lib/src/test_env.dart`，默认 false，生产不开启；后者仅测试进程）。

### 已知缺陷 · T-L3c（进行中）

- C 路线 `uRadiusPx` 未含 `orbStretch(pull)`，裁剪椭圆与着色器圆形不同构：拖动时沿拉伸方向会有约 `(stretch−1)·R`（pull=1 时 ~1.7 逻辑像素）透明缝隙，且内容不随玻璃拉伸。A 路线无此问题。
- 已派回同一实现者补 `uStretch` 与对应断言（透明度扫面 + 倍率），单列一个 fix commit。
- 交付后仍属“待真机/待体验”：首捕获 97–158ms 的卡顿、Impeller 与 Skia 的 matrix 差异、拖动期 ≤1 帧锚点滞后、快照陈旧度，均需 T-L7 在真机上确认。

### T-L3c · 拖动拉伸同构（`d78c6a2`）

- 文件：`shaders/orb_lens.frag`、`lib/src/widget.dart`（+12）、`test/orb_lens_shader_test.dart`（+195/−29）。
- 改动：shader 增 `uStretch` / `uAngle`，先把 `delta` 旋到拖动帧再按椭圆归一化（长轴 ÷ `R×stretch`、短轴 ÷ `R`）；painter 从 `pull` 取 `orbStretch` 并纳入 `shouldRepaint`。
- 证据（实现者，着色器级逐像素）：`stretch=1.04`、`angle=0` 与 `0.6 rad` 沿长轴扫到 `0.999×R×stretch=207.79px`，208 点、透明像素 0；长轴外 `1.01×` 恢复透明；旋转方向已由“屏幕 y 轴同距离处透明”举证；该方向倍率 `1.6875`。
- 独立复跑（规划者）：`flutter analyze` 无问题；`flutter test` **394 passed**（392+2）；`examples/flutter` 未改动，先前 38 例仍绿。
- **变异检查暴露的测试盲点（未修）**：把 `widget.dart` 的 `setFloat(8, stretch)` 改成 `setFloat(8, 1.0)` 后，**全部测试仍通过**。原因是着色器数学用例直接调用 `_paintLens(stretch: 1.04)` 自行写 uniform，组件层用例只断言 `_OrbLensShaderLayer.stretch/angle` 字段，没有任何用例端到端校验 painter 写进 shader 的第 8/9 号 uniform。已还原改动，worktree 干净。
  - 影响面：若未来误删/错序这两个 uniform，球缘会出现约 1.7px 的未放大缝隙，只有真机肉眼可见。
  - 暂不补测试的理由：该缝隙在 84px 球上只有 ~2px 环带，widget 级像素断言易受抗锯齿与条纹相位影响、稳定性差；留到 T-L7 用真机/大图截图核对，必要时改为在 painter 外侧暴露 uniform 快照再断言。
- 已知残留（实现者提出，规划者接受）：透镜绘制区域等于球盒，椭圆长轴端超出的 `(stretch−1)·R ≈ 1.7px` 不会被绘制；A/C 同限，且该圈被 painter 白色球缘覆盖，实测剖面不可分辨。若 T-L7 看出缺口，再给两条路线各加一点绘制外扩。

## 12 T-L4 修订与裁决（2026-10-29）

**原卡内容**：新增“月牙高光”+“内圈色散”两个 Flutter 绘制层。开工前核对证据后发现前半段与已定契约冲突，故裁决如下。

### 12.1 裁决：不做“月牙高光”层

- spec §12.4（官方视频实测）明确：`r < 0.80R` 球内区域两帧中 `L ≥ 245` 的像素数为 0，球内最亮点与白环内侧衰减段同量级，**不存在独立高光**；并已将 `18×10` 椭圆高光与 4px 亮点判为废止。
- 官方包取证（本记录 §2）：主着色器 `Highlight` 在构造中未赋值（默认 0）。
- 本轮四张参考帧（`reference-lock-desktop` / `reference-about` / `reference-folder` / `reference-gif-frame-30` 的并排图）中，球沿最亮处都可由“径向白环 + 背景明暗”解释；`reference-about` 的大球是白色径向环 + 紫青色散，没有固定方向的月牙亮斑。
- 因此，“月牙”来自最初对截图的人工印象，不是测量结论；按 §12.4 与“不得自拟参数冒充官方”的原则，**不实现固定月牙层**。若后续拿到原始 GIF 并量出方向性亮斑（与控制背景无关），再单开一片，届时以实测弧宽/内缩/峰值 alpha 为准。

### 12.2 本卡改为：C 路线透镜内圈色散（官方参数比例推导）

- **目标**：C 路线当前单次采样，无 RGB 分通道；官方主着色器对 RGB 分别采样（`Dispersion = 0.61`）。本卡在 `orb_lens.frag` 中补上径向分通道偏移，A 路线保持不变（矩阵滤镜无法分通道）。
- **幅度推导（设计推断，必须如此标注）**：官方 `Dispersion / Refraction = 0.61 / 1.31 ≈ 0.466`；本实现球缘源点位移为 `1 - 1/1.70 = 0.412R`；两者相乘得球缘分通道偏移约 `0.072R`（56px 球约 2.0px，84px 约 3.0px），沿半径方向、随 `r²` 增长，球心为 0。
- **常量**：`kFeedbackOrbLensDispersionEdge = 0.05`（初值 `0.072` 由官方参数比例推导；2026-10-29 用户看过前后对比图后判定彩边偏强，指定收敛为 `0.05`，属**观感裁决**而非重新推导；注释保留“非实测”定性）。
- **实现**：在着色器里沿径向单位向量分通道采样；R 向内、B 向外各偏 `offset/2`，G 居中；不得改变 alpha 与倍率。
- **验收**：
  1. 着色器级：硬边夹具上量 B 与 R 的边沿位置差。定义 `单通道偏移 = 0.5 × kFeedbackOrbLensDispersionEdge × r² × radiusPx`，则 `B−R 总位移 = kFeedbackOrbLensDispersionEdge × r² × radiusPx`；`r = 1` 时为 `0.072R`（56px 球 2.0px），`r = 0.9` 约 `0.058R`（±25%），`r < 0.2` 时 < 0.3px；倍率与不分通道版本差 < 1%。
  2. 亮度中性：纯灰背景上球内平均亮度变化 < 2/255，alpha 剖面与改动前一致。
  3. 组件层：C 路线前后对比截图（球压在条纹/文字上），并确认 A 路线像素未变。
  4. `flutter analyze` + 全量 `flutter test` + `examples/flutter` 全绿，用例数不减。
- **边界**：不改捕获/重试/降级、不改 painter、不改 Web、不新增依赖、不新增公开 API。
- **未验证**：分通道幅度没有官方帧实测锚点，只有比例推导；真机观感与 §12.6.1 壳层色散的衔接留 T-L7。

## 13 T-L4 结果（2026-10-29）

- commit `32f3de8` `feat(orb): C 路线透镜补径向分通道色散`；改动 4 个文件：`shaders/orb_lens.frag`（+`uDispersion`，R 向内/B 向外/G 居中，alpha 取中心采样）、`lib/src/orb.dart`（`kFeedbackOrbLensDispersionEdge = 0.072`，注明比例推导非实测）、`lib/src/widget.dart`（+1 行 `setFloat(10, …)`）、`test/orb_lens_shader_test.dart`（+2 用例 + 测量辅助）。
- 实测（实现者，flutter_tester 真实光栅）：球缘 `B−R` 13.91px（目标 13.83，+0.6%）；`r=0.9` 11.83px（+1.5%）；`r≈0.1` 0.084px（<0.3）；球心倍率前后均为 1.7552/1.7448（0.00%）；纯灰平均亮度 Δ0.0000；alpha 剖面差异 0 像素；A 路线 RGBA 逐字节相同。
- 独立复跑（规划者）：`flutter analyze` 无问题；`flutter test` **396 passed**；4 文件、分支干净。
- 变异检查（规划者）：
  - 把 shader 的 `shift` 置 0 → 色散位移用例转红（**着色器数学用例有效**），已还原。
  - 把 painter 的 `setFloat(10, kFeedbackOrbLensDispersionEdge)` 改成 `setFloat(10, 0.0)` → **全绿**（新盲点：uniform 8/9/10 的写值仍无端到端校验），已还原。
- 因此追加 **T-L4b**（进行中）：把 11 个 float uniform 收敛为 `orbLensUniformValues(...)` 纯函数，painter 改为按序循环写入；新增用例从 `shaders/orb_lens.frag` 解析 `uniform` 声明顺序并与函数输出对齐，另逐项断言 `uScale/uCenter/uRadiusPx/uStretch/uAngle/uDispersion`。要求实现者做索引错位的变异自查。此卡不改任何像素。
- 视觉证据（仓库外）：`仓库外证据（tl4）/c-before.png` 与 `c-after.png`。高对比条纹夹具下球缘可见红/蓝镶边，差异集中在 `r/R ≥ ~0.21`；条纹是刻意的高频夹具，实际内容上会比这张图克制。
- 未验证：色散幅度无官方帧实测锚点（比例推导）；Impeller 下的观感与抗锯齿需 T-L7 真机。
- **2026-10-29 参数裁决**：用户看过后认为 `0.072R` 彩边偏强，指定改为 `0.05R`。新值下球缘 `B−R` 理论位移 `0.05R`（56px 球 1.4px、84px 球 2.1px），由 T-L4c 落地并重出对比图；旧值证据保留在 `仓库外证据（tl4）/`。

## 14 T-L4b / T-L4c 结果（2026-10-29）

- **T-L4b** `e4834a6` `test(orb): 锁定透镜着色器 uniform 顺序与取值`：新增 `orbLensUniformValues(...)` 纯函数（11 个 float 按 shader 声明序），painter 改为按序循环写入；用例从 `shaders/orb_lens.frag` 解析 `uniform` 声明顺序并与函数输出对齐，另逐项断言 `uScale/uCenter/uRadiusPx/uStretch/uAngle/uDispersion`。像素零变化。
- **T-L4c** `d2750e1` `fix(orb): 透镜色散按观感收敛到 0.05R`：`kFeedbackOrbLensDispersionEdge = 0.05`（初值 0.072 为比例推导，0.05 为用户观感裁决，注释保留“非实测”）。
- 实现者自报实测（R=200 图像像素）：球缘 `r≈0.98` 9.714px vs 理论 9.604（+1.1%）；`r=0.9` 8.000 vs 8.100（−1.2%）；`0.02–0.18R` 带 0.121px；球心倍率 0.00%；纯灰亮度差 0.0000；alpha 差 0 像素。
- 仪器更正（实现者主动修正）：球缘在 `r≈1` 处放大表约 7 源像素/屏幕像素，硬边交点读不出 0.05R 的位移，改用斜率 4 的渐变窗口；并修正 T-L4 渐变换算多乘一次导数的问题——T-L4 回执里“0.1R 偏低 40%”的解释是错的，已作废。
- 独立复跑（规划者）：`flutter analyze` 无问题；`flutter test` **400 passed**；worktree 干净；常量为 `0.05`。
- 变异检查（规划者）：把 `orbLensUniformValues` 的索引 8/9（stretch/angle）互换 → **2 条用例转红**，说明新增的 uniform 接线守卫有效；已还原。
- 视觉证据：`仓库外证据（tl4c）/c-before-crop.png`（0.072）与 `c-after-crop.png`（0.05），后者球缘蓝/橙镶边明显更细。
- T-L4 结论：功能与回归通过，状态**待体验**；幅度仍无官方帧锚点，真机观感留 T-L7。

## 15 T-L5 并入 T-L6 与文档收口（2026-10-29）

- 用户确认：**T-L5 并入 T-L6**。原 T-L5 的“Web 月牙/内圈色散近似层”不再实现：月牙已按 §12.1 废止；Web 无放大能力，单独加彩色内边等于重复已有壳层色散，缺依据。
- 本次文档收口：
  - `docs/orb-spec.md`
    - §4 补充约束 1、§7.1、§10.1、§12.3：把“两端不使用 BackdropFilter”改为精确口径——`packages/web` 全面禁止；Flutter 只允许透镜采样层使用 `BackdropFilter(ImageFilter.matrix)`（A）或捕获 + shader（C），均无 blur。
    - 新增 **§13.8 实现状态与平台差异**：Flutter 已实现的能力/证据表、平台差异（Web 不放大）、已知代价与未验证项。
  - `flutter/feedback/README.md`：灵感球条目补“真实放大镜”、单次本地捕获、失败退回 1.70× 矩阵、不上传/不写盘/不周期捕获。
  - `packages/web/README.md`：灵感球条目明确 **Web 不做背景放大** 及原因，指向 spec 13.5。
  - `docs/integration.md` §5.4（Flutter）：新增灵感球透镜说明（单次捕获、无周期捕获、Web 不放大、平台纹理可能不进捕获图）。
- 一致性检查：`grep -n "BackdropFilter\|backdrop-filter"` 后，仅剩 §13.4/§13.5/§13.8 的“允许范围”描述与 `packages/web/src/styles.ts` 中弹窗/选区读数的模糊（非 orb），无残留的“两端均禁止”绝对句。
- 未改动：`packages/web/src`、`flutter/feedback/lib`、`e2e`、`examples`。
- T-L6 状态：文档部分完成；最终一致性还要在 T-L7 结束后复查一次（截图/数字可能变）。

## 16 T-L7a 自动回归结果（2026-10-29）

被测：worktree 分支 `feat/20261029-orb-lens-replica` @ `d2750e1`；结束时 worktree 干净，未改源码、未提交、未更新基线。Web/e2e 相对 main 无 diff（`git diff main..HEAD -- packages/web e2e` 为空），因此 Web 结论是“未改动 + 全绿”。

| 命令 | 结果 |
| --- | --- |
| Flutter 组件包 `analyze` / `test` | 无问题 / **400 passed** |
| `examples/flutter` `analyze` / `test` | 无问题 / **38 passed** |
| Web `test` / `typecheck` / `lint` / `build` | **359 tests** / exit 0 / exit 0 / exit 0 |
| e2e `run_orb_shots_web.py` | PASS 171 / FAIL 0 |
| e2e `run_orb_contrast_web.py` | 17 passed / 0 |
| e2e `run_orb_forced_colors_web.py` | 21 passed / 0 |
| e2e `run_orb_motion_browser.py` | PASS 50 / FAIL 0 |

契约：
- 56 / 84、七态、命中区、badge、焦点环 2+2、hidden 无入口、forced-colors 环可见（21:1）全部通过。
- 对比度保持率：Web light 0.8997 / dark 0.8988；Flutter A 0.8636 / 0.8640；Flutter **C 0.8838 / 0.8835**；fixtureRatio 1.0000。
- 透镜层不新增 Semantics 节点（A=C=5），不扩大命中区。

视觉证据（仓库外）：`仓库外证据（tl7/flutter）/`（11 张，56/84 × 浅/深 × A/C + 焦点环 + hidden）与 `仓库外证据（tl7/web）/`（5 态 × 2 主题 + contrast + forced-colors，共 16 张）。Web 矩阵实际是 10 张而非任务卡预估的 20 张，未臆造补齐。

**风险与后续**：
1. **C 路线（生产默认）的 12.3.1 对比度、命中区、Semantics 只有临时用例**，T-L7a 结束后归零 → 已开 **T-L7c** 固化为 `test/orb_lens_contract_test.dart`（正式回归）。
2. A 路线保持率 0.8636 / 0.8640，距 0.85 仅约 1.4pp；这是矩阵重采样本身的代价（放大 1.70× 会平滑背景），继续满足契约，但余量小，记为观察项。
3. Web 非强制模式焦点环 2.849:1 < 3:1 为既有遗留，与本轮无关，待单独裁决。
4. 真机项（首捕获延迟、PlatformView 不进捕获、Impeller 观感、拖动锚点）仍归 T-L7b。

## 17 T-L7b 真机（Android 模拟器）首轮结果与缺陷（2026-10-29）

- 设备：Android 16 模拟器（API 36，1080×2400，DPR 2.625）；`examples/flutter` 以 `--profile` 运行；交互用 `adb shell input swipe`，截图用 `adb exec-out screencap -p`。
- macOS 桌面未能起跑：`Runner` 需要开发团队签名（`Signing for "Runner" requires a development team`），未改工程签名，留待有签名环境时补。
- **发现的真实缺陷（P1）**：C 路线在 Android/Impeller 上，球内放大的内容是**倒的**（球外同一行文字为正）。证据：`仓库外证据（tl7/android）/drag-mid.png` 与 `drag-mid-ball-zoom.png`。拖动中球为 84px，球内汉字明显上下/旋转颠倒。
- 影响的验证盲区：T-L1 尖刺与 T-L3/T-L4 的全部像素夹具都是条纹、居中暗线、对称方块，**上下或 180° 翻转在这些夹具上不可见**；测试渲染器（Skia）上“23”等文字是正立的，所以自动化没拦住。
- 初步判断：`FlutterFragCoord()` 在 Impeller 与 Skia 的原点约定可能不同（shader 换算假设左上原点）。尚未定性，已开 **T-L7d** 让实现者隔离“捕获图方向 vs shader 采样坐标”、用非对称夹具定型翻转类型、修复并补能拦住翻转的回归。
- 本轮未能验证：首捕获耗时、帧时间、PlatformView 不进捕获、拖动锚点滞后。模拟器上 C 路线至少成功接管（球内确有放大内容），未观察到崩溃。

## 18 T-L7d Impeller 翻转修复（2026-10-29）

- commit `b71d210` `fix(orb): 修正 Impeller 下 C 路线透镜内容翻转`，仅改 `shaders/orb_lens.frag` 与 `test/orb_lens_shader_test.dart`。
- **定型**：垂直镜像（不是 180° 旋转）。把球内截图垂直翻转后文字正读、左右顺序不变。
- **根因**：模拟器后端为 `Impeller (OpenGLES)`；3.47 之前 Impeller 的 GLES 后端把渲染目标纹理按自下而上存放，自定义着色器按 `v = y/H` 采样捕获图得到镜像行。Skia（flutter_tester、Web）、Metal、Vulkan 均为自上而下，所以此前全部像素用例与桌面证据都正常。
- **为何测试没拦住**：条纹、水平对称暗线、居中方块在上下翻转下不变。
- **修复**：采样统一收进 `sampleLens()`，仅在 `IMPELLER_TARGET_OPENGLES && !IMPELLER_OPENGLES_UNFLIPPED_DEPRECATED` 时翻转 `uv.y`；3.47 起该宏由 SDK 定义，分支自动失效。几何、色散数学、uniform 顺序未动。
- **回归**：新增非对称夹具（左上/右上不同尺寸白块、组件层球心左上黑块）与源码守卫（`texture(uBg` 只允许出现在 `sampleLens` 内），翻转类变异会红。实现者自报 `flutter analyze` 无问题、`flutter test` 408 通过；**规划者独立复跑：analyze 无问题、408 passed**。
- **设备复测**：实现者在同一模拟器重跑并截图，球内文字正立（`仓库外证据（tl7/android-after）/drag-text-ball.png`，球内“切到第…”与球外同向）。规划者自己的复测因 `adb input` 时序反复落进选区覆盖层，未取得可用中拖帧，故以“实现者设备图 + 规划者测试复跑”作为本轮证据，并如实记录该限制。
- 仍未验证：首捕获耗时与重试、持续帧时间、PlatformView 不进捕获、拖动锚点 ≤1 帧滞后。Web 未改动，e2e 结论沿用 T-L7a。

## 19 T-L8 只读代码审查结论（2026-10-29）

对象：`404f7cf..b71d210`，8 个 commit、10 个文件、+2894/−14。只读复跑：`flutter analyze` 无问题、`flutter test` **408 passed**、example 资源用例 1 passed；worktree 保持干净。

**结论：可合并，无阻断项。** 建议合并前修 3 条中危（M1–M3）。

已核查无问题（摘要）：范围只含 `flutter/feedback` 与 example 测试；无新依赖；公开 API/导出未变；透镜层无 blur；无周期捕获、无新增 Timer；捕获不写盘不上传不进日志；uniform 顺序与 `shouldRepaint` 完整；GLES 宏在 3.41.3 的 GLES/GLES3 产物中确实生效、3.47 失效（审查者用 impellerc 实测）；A 的 `G·S·G⁻¹` 与 painter 变换链一致；命中区/焦点链/Semantics 不变；hidden 真卸载；`ui.Image` 无双释放。

问题清单：
- **M1** 着色器在 `toImage` 之后解析，shader 不可用时白做 3 次整窗捕获、且每次拖动开始再白捕一次。
- **M2** `sourceRect`/`anchorGlobal` 在 `await toImage` 之后取，与位图不同刻；锚点有三处来源。
- **M3** 1s 闸门用 `DateTime.now()` 墙钟，校时回拨可锁死；相关用例依赖 `realDelay(1100)`，慢 CI 有翻转风险。
- **M4** build 期同步写 `_lensSnapshot`（hidden 分支），依赖“监听者是后代”的实现细节。
- 低危：`_lensFirstCaptureScheduled` 早退不复位；shader 资源键根键优先 + dispose 竞态可能泄漏一个 shader；捕获异常静默；Dart 径向表在 lib 中零调用（只有测试自指）；契约测试内联 controller/client 未释放。

测试盲点：触发节奏/并发（重试上限、单在途、只在拖动开始捕获）无法观测；painter→shader 端到端数值（DPR/breathFactor 漏乘）无断言；A 拖动下的放大中心无像素断言；GLES 翻转只有源码正则；`ui.Image` 真释放不可观测；无 `toImage` 抛错注入；测试开关在 release 仍可写。

**后续**：已开 **T-L8a** 修 M1–M4 + L1/L2/L3/L5，并补“shader 表与 Dart 表一致性”“捕获触发计数”两个盲点；完成后再做一次短复查。

## 20 T-L8a 结果（2026-10-29）

- commit `67bf794` `fix(orb): 收敛透镜捕获失败路径与闸门健壮性`（4 文件，+170/−46）：M1 着色器前置、M2 几何与位图同刻、M3 `Stopwatch` 单调闸门 + 测试注入、M4 释放移到帧后、L1 早退复位、L2 包前缀键优先 + dispose 守卫、L3 捕获异常留线索、L5 合同测试补 teardown。
- 新增用例 3 条：shader 径向表与 Dart 表逐项一致；捕获节奏（首次 1 次、闸门内 0 次、放开后拖动 1 次）；失败路径最多 3 次且 shader 不可用 0 次。
- 实现者变异自查：还原 M1 旧顺序 → 注入用例红（0 vs 3）；重试上限改 5 → 红（3 vs 6）；Dart 表改 1.679 → 表一致性用例红。均已还原。
- 规划者复查：diff 仅上述 4 文件；M1 顺序、M2 取样时刻、M3 闸门语义、M4 帧后释放均与建议一致；测试开关默认值不变；无像素参数、shader 数学、uniform 顺序、Web/docs 改动。
- 规划者复跑：`flutter analyze` 无问题、`flutter test` **411 passed**、`examples/flutter` **38 passed**。
- 遗留观察：A 路线保持率 0.8636/0.8640 距 0.85 约 1.4pp；真机帧时间与首捕获耗时仍属 T-L7 未完成项。

## 21 合并记录（2026-10-29）

- 文档提交：`ae94222` `docs(orb): 记录透镜复刻的契约、裁决与验证`（spec 13、任务记录、Flutter/Web README、integration）。
- 合并提交：`f1d4a1b` `Merge branch 'feat/20261029-orb-lens-replica'`（`--no-ff`，含 `5b561f8`…`67bf794` 共 11 个实现/测试提交）。
- 合并后复跑（主工作区）：`flutter analyze` 无问题；`flutter test` **411 passed**；`examples/flutter` **38 passed**。
- 本地 `main` 领先 `origin/main` 12 个提交；**尚未推送**（推送/PR 待授权）。
- worktree `worktrees/personal-feedback/20261029-feat-orb-lens-replica/` 与本地分支保留，待推送与体验结束后按数据保全规则清理。
- 仍未完成（不阻塞合并）：真机帧时间、首捕获耗时与重试、拖动锚点滞后、PlatformView 不进捕获；以及 Web 非强制模式焦点环 2.849:1 的历史遗留裁决。
