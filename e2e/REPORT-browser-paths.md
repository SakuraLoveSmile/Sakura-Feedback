# 真实浏览器 E2E 验证报告：灵感球拖动 / 遮罩 / 登录握手

对象仓库：`/Users/sakurasep/Documents/Code/Project/Personal Project/Feedback`
被测产物：`packages/web/dist/feedback-web.umd.cjs`（`pnpm --filter @feedback/web build` 的当前构建）
真实浏览器：系统 Chrome（Playwright `pw.chromium.launch(headless=True, channel="chrome")`，
本机未安装 `chromium_headless_shell-1208`，脚本已内置回退）
真实服务：`apps/server`（tsx 直跑，SQLite），两个实例（8787 / 8788）+ Kaneo/AI mock（8898 / 8899）

## 1. 命令与结果（真实退出码）

```bash
# 单条命令、可重复；工作目录 = 仓库根
python3 e2e/run_browser.py
```

| 运行 | 断言 | 结果 | 退出码 | 日志 |
| --- | --- | --- | --- | --- |
| 最终代码 | 174 PASS / 0 FAIL | `=== E2E 结果：174/174 通过 ===` | `EXIT=0` | `/tmp/e2e-final.log` |
| 连续重跑（少 T1 的一条新增断言） | 173 PASS / 0 FAIL | `=== E2E 结果：173/173 通过 ===` | `EXIT=0` | `/tmp/e2e-full3.log` |
| 连续重跑（同上） | 173 PASS / 0 FAIL | `=== E2E 结果：173/173 通过 ===` | `EXIT=0` | `/tmp/e2e-full2.log` |
| 修改前（原始脚本） | 首个断言即失败 | `FAIL 组件注册且悬浮按钮可见` → `AssertionError` | `EXIT=1` | 本次任务开始时的工作区内运行 |

按步骤统计（`/tmp/e2e-final.log`）：

```
  2 PASS T1... 配置连接与软件        4 PASS  T1 加载与呼出
  2 PASS  T2 Esc 关闭与焦点恢复      1 PASS  T3 草稿保留
  2 PASS  T4 超限禁提交              6 PASS  T5 未登录提交 → 弹窗握手 → 归档
  8 PASS  T6 Kaneo 任务契约          8 PASS  T7a 服务端 AI 整理失败（文档化分支）
 14 PASS  T7b 提交未到达服务 → 重试    2 PASS  T8 跨域会话恢复
  1 PASS  T9 窄屏布局                3 PASS  T10 Vue 示例接入
 33 PASS  P1 灵感球拖动             24 PASS  P2 遮罩像素级
 17 PASS  P3 遮挡失败规则           19 PASS  P4a 异源消息必须被忽略
 13 PASS  P4b 正确 origin + 错误 nonce   15 PASS  P4c 切换 api-base 凭据隔离
```

调试便利（不作为交付结果）：`E2E_ONLY_PATHS=1 python3 e2e/run_browser.py` 只跑 P1–P4（123/123，exit 0）。

## 2. 三条路径 ↔ 测试函数

| 需求路径 | 测试函数（`e2e/browser_paths.py`） | 宿主页 |
| --- | --- | --- |
| 灵感球拖动 → 落点指向问题 → 视口截图 | `p1_orb_drag`（33 断言） | `e2e/pages/orb.html` |
| 遮罩像素级（`data-feedback-capture-mask` + `input[type=password]`） | `p2_mask_pixels`（24 断言） | `e2e/pages/mask.html` |
| 遮罩失败规则（可见敏感区无法遮挡 → 必须失败） | `p3_mask_failure`（17 断言） | `e2e/pages/maskfail.html` |
| 登录握手（真实弹窗 + 严格校验 + 切换 api-base 隔离） | `p4_login_handshake`（P4a/P4b/P4c，共 47 断言） | `e2e/pages/login.html` + `e2e/pages/attacker.html` |

入口：`e2e/run_browser.py:scenarios()` 末尾构造 `deps` 并调用 `browser_paths.run(deps)`，
复用同一份 mock/服务编排，没有第二套 harness。

## 3. 原始证据

### 3.0 像素解码方法（明确写出）

`e2e/png_probe.py` → `png_probe.backend()` = `Pillow 10.4.0 解码 + numpy 2.2.6 向量化统计`
（`Image.open(BytesIO).convert("RGBA")` → `numpy.asarray`；不用 sharp、不用手写 zlib）。
脚本每次运行会打印该方法并落盘裁剪图到 `e2e/shots/`。

视口 1280×800、DPR=1 → 组件截图 `scale=min(dpr,2,…)=1`，**CSS 视口坐标 == PNG 像素坐标**，
因此可以直接用 `getBoundingClientRect()` 的矩形做像素断言（脚本对这个前提有断言：
`P1 截图就是宿主视口尺寸 1280x800（dpr=1 → scale=1）`）。

### 3.1 P1 灵感球拖动

真实鼠标：`mouse.move(灵感球中心) → down → move(256,192, steps=12) → up`。

- `P1 拖动中灵感球进入 is-dragging 态（真实指针事件）` PASS
- `P1 释放后反馈面板打开` / `P1 截图写入草稿（缩略图可见）` PASS
- 拖拽结束后元素位移复位：`{"transform": "none", "cls": "fb-launcher fb-orb is-hidden"}`，
  关闭面板后 `{"transform":"none","display":"flex","x":1212,"y":552,"width":48,"height":48}` PASS
- 截图 = 宿主视口：客户端 PNG `{"bytes": 29183, "sha256": "a9b689…", "size": [1280, 800]}`；
  灵感球原位 48×48 区域**全白**（`matching 1936 / mismatching 0`）→ 球不在图里；
  组件强调色 `#0071e3` 全图 **0 像素** → 组件 UI 不在图里
- 落点被记录并用于指向问题（全链路）：
  1. 客户端草稿 blob `sha256` 与上传字节一致（`P1 上传的截图字节 == 本地做像素断言的同一份`）
  2. 提交 multipart `metadata.capture`:
     `{"viewportWidth":1280,"viewportHeight":800,"pixelWidth":1280,"pixelHeight":800,"capturedAt":"…","releasePoint":{"x":0.2,"y":0.24}}`
  3. 服务端 `GET /api/admin/feedback/:id` 的 `screenshot.capture.releasePoint` = `{"x":0.2,"y":0.24}`
  4. AI 归档提示原文：
     `【反馈原话开始…】\n灵感球拖动落点验证：导出按钮卡住\n【反馈原话结束】\n【截图输出尺寸】：1280 x 800 像素（最终 PNG 的实际输出像素）\n【用户关注落点】：归一化坐标 x=0.20 (20%), y=0.24 (24%)，表示用户指出此问题时关注的界面位置。`
  5. 落点像素确实指向问题区域：`(256,192)` 处 8×8 全为 landmark 的 `rgb(255,0,0)`（64/64）
- 图文归档旁证：Kaneo mock 记到资产 + 评论，且**预签名上传地址零凭据**
  （`uploadAuthLeaks: []`，服务端「绝不向存储地址携带 Kaneo API Key」）
- 有草稿时重新呼出不重拍：草稿 blob `sha256` 前后一致 PASS

### 3.2 P2 遮罩（像素级，客户端 PNG 与服务端落库 PNG 都验）

宿主页：`#secret-card`（500,80,360×200，`data-feedback-capture-mask`，原色 `#ff00ff`）、
`#pw`（500,340,360×48，`input[type=password]`，原色 `#00ffff`）、
`#visible-block`（60,60,320×180 绿）、`#footer-block`（60,400,320×120 蓝）。

客户端 PNG（`sha256 0a01879a…`，28320 B）逐像素：

```
[mask] 区域      rect(500,80,360,200) inset 3 → 68676/68676 = rgb(110,110,115)  ratio 1.0
password 区域    rect(500,340,360,48) inset 3 → 14868/14868 = rgb(110,110,115)  ratio 1.0
正常内容(北)     ratio 0.9825（其余为文字/抗锯齿）且 maskColorPixels = 0
正常内容(南)     ratio 0.9735 且 maskColorPixels = 0
遮挡左侧紧邻带   ratio 1.0（纯白）且 maskColorPixels = 0 → 遮挡没有外溢
password 上方带  ratio 1.0（纯白）且 maskColorPixels = 0
全图统计          #ff00ff = 0 像素、#00ffff = 0 像素（敏感区原色全图绝迹）
```

服务端落库 PNG（管理端 `GET /api/admin/feedback/:id/screenshot`，`sha256 a13bf339…`，10725 B）：
`[mask]` 68676/68676、`password` 14868/14868 均为 `rgb(110,110,115)`，绿块保持原色，
`#ff00ff`/`#00ffff` 全图 0 像素。

> 说明：服务端会重新编码 PNG（`byteSize 10725` vs 客户端 28320，sha256 不同），
> 因此字节级比对只在「浏览器上传的字节 vs 客户端 PNG」之间做，服务端侧一律用像素断言。

### 3.3 P3 遮挡失败规则

1. 正常遮挡（对照）：第一次截图敏感区 68676/68676 = 遮挡色，原色 0 像素
2. **可见敏感区无法遮挡 → 整次截图失败**（真实现象，宿主页没动任何应用代码，
   只在被标记元素的包裹层加 `data-html2canvas-ignore`，敏感元素在真实文档里仍然可见）：
   - 控制台真实报错：
     `CaptureError: [locate-failed] 页面有 1 个可见敏感区域，但克隆上仅定位到 0 个，无法保证遮挡`
   - 用户可见文案：`截图未完成，可重试或继续文字反馈`
   - 旧草稿文字保留（`page.locator(".fb-textarea").input_value()` 不变）
   - 旧截图字节保留：失败前后草稿 blob `sha256` 都是 `7cf1bf5c…`
   - 失败路径 **0 次**提交请求
3. 泄漏型 `captureProvider`（返回真实未遮挡截图、不声明同帧遮挡）：
   该图含 69095 个未遮挡 `#ff00ff` 像素（测试前提成立）→ 组件**拒绝采纳**、
   提示「截图未完成」，草稿哈希不变，整个 P3 期间没有任何请求携带泄漏图字节
4. 正向对照：同一张图 + `sameFrameMasking: true` + `maskedRegions` 声明 → **被接受**
   （`newDraftHash == leakyHash`），证明负例的成因是「缺声明」而不是笼统拒绝

### 3.4 P4 登录握手

每个子用例用独立 `browser.new_context()`（无 Cookie），保证弹窗停在真实待登录状态。

- **P4a 异源消息**：宿主 `http://localhost:5189`，攻击页 `http://127.0.0.1:5189`（真异源）。
  攻击页把**本次真实 nonce + 伪造令牌**投给 opener，宿主页确实收到了这条消息
  （`{"origin":"http://127.0.0.1:5189","type":"feedback:auth","nonce":"d1fe6b…","token":"FORGED-TOKEN-FROM-WRONG-ORIGIN"}`），
  但组件忽略它：没有任何请求带伪造令牌、没有提交、按钮仍是「登录并提交」、草稿保留；
  之后在同一个弹窗里真实登录成功，提交携带的就是握手签发的真实令牌（`Bearer Gx5kNmZ…`），
  且该令牌 ≠ 伪造令牌。
- **P4b nonce 不匹配**：从**真实服务 origin**（`http://localhost:8787`，弹窗内）投递
  `type=feedback:auth` + **正确类型但错误 nonce** + P4a 真实签发过的旧令牌：
  宿主页收到消息、组件忽略（无提交、`该旧令牌没有被用于任何请求`）、仍显示需要登录；
  随后真实登录仍成功，且新令牌 ≠ 被重放的旧令牌。
- **P4c 切换 api-base**：先在 8787 登录并提交成功（`Bearer <old>` 只出现在 8787 的请求上，
  全流程扫描：`[{"POST","http://localhost:8787/api/feedback"},{"GET","http://localhost:8787/api/feedback/<id>"}]`）；
  切到 `http://localhost:8788` 后草稿被清空，点提交只为**新服务**打开登录窗
  （`http://localhost:8788/login?appId=…&cb=http%3A%2F%2Flocalhost%3A5189`，`authorization: null`）；
  断言「没有任何打到新服务的请求带旧服务 Authorization」「未重新登录前不会向新服务发提交」；
  在新服务真实登录后提交只带新令牌 `Bearer a4DSN4S…`，新 ≠ 旧。

## 4. 对既有场景做的期望更新（逐条说明改了什么、为什么）

> 依据：`packages/web/README.md`、`docs/api.md`、`packages/web/src/element.ts`、`styles.ts` 的行为与文案。

1. **入口选择器（T1/T2/T3/T9/T10）**：`examples/react`、`examples/vue` 现在显式声明
   `launcher-mode="orb"`（默认是 `tab`，示例里显式覆盖）。orb 模式下贴边标签被
   `:host([launcher-mode="orb"]) .fb-tab-launcher{display:none}`（`styles.ts:260`）隐藏，
   所以原脚本对 `.fb-fab` 的 `is_visible()` 断言**必然为假**（这就是修改前 T1 第一个断言失败的原因）。
   改为按 `launcher-mode` 解析真实入口，并新增一条显式断言「贴边标签在 orb 模式下按文档隐藏」。
2. **呼出时序（T1/T3/T9/T10）**：`capture-mode="viewport"` 的宿主是「先截图后开面板」，
   原脚本「点击后立刻 `is_visible()`」不再成立 → 改为 `wait_for(state="visible")`（断言内容不变）。
3. **登录入口（T5/T8/T10）**：未登录点「提交」时组件在 `submit()` 里直接 `beginLogin(true)` →
   `handshake.openPopup()`（`element.ts:1183/1500`），**第一次点提交就开窗**；且 `.fb-login-area`
   这个类在 `packages/web/**` 与两个示例产物中都不存在（旧脚本用的是不存在的类）。
   组件未登录时是把主按钮改成 `.fb-login` 并把状态设为「需要登录」（`element.ts:1599`）。
   改为「点提交 → `expect_page` → 弹窗内完成登录」，并断言主按钮文案 = `登录并提交`、状态含 `需要登录`。
4. **T5 等「已接收」**：原脚本等状态文案出现 `已接收`，但组件在 tracking 阶段渲染的是
   `已保存，正在整理`（`element.ts:1229`），`已接收` 全仓库只出现在注释/文档里。
   改为等**文档化行为**「201/200 后才清空输入与草稿」（`README §提交流程`），
   随后仍按原样等 `.fb-task-link`（已归档）。**这属于文档与 UI 文案不一致**，见第 5 节第 1 条。
5. **T7 失败分支**：原脚本用 mock AI 500 注入失败，却断言 `.fb-error-summary` + `.fb-retry`
   ——那是「提交未到达服务」的客户端分支（`element.ts:1704` 分支 4）。服务端已接收但后台处理
   失败走的是分支 2（`element.ts:1659`：`原话已保存，后台整理未完成…请勿重复提交` +
   刷新状态/复制标识，**绝不再次 POST**，`README §提交流程`/§卡片、`docs/api.md`）。
   拆成两条，两条都真跑：
   - **T7a**（保留原注入点 `aiFail=true`）：断言分支 2 的真实文案、反馈标识、刷新/复制按钮、
     **不提供「重试提交」**、3 秒内无自动重发、服务端只收到 1 次提交。
   - **T7b**（原意图「失败 → 修复 → 重试归档」）：用浏览器网络层真实中断
     （`route.abort("connectionfailed")`）制造「提交未到达服务」，断言保留原输入、
     `errorSummary`、`重试提交`、管理端无新记录；恢复后点重试 → 归档，
     并从两次真实请求体证明**同 key 同字节**（`idempotencyKey` 相同、上传字节 87223 B 相同）。
6. **T9 清理动作**：`Esc` 只在焦点位于组件内部时关闭面板（`element.ts:1785` 的 `inside` 判定），
   登录弹窗关闭后焦点回到宿主页 `body`，原脚本的收尾 `Esc` 不再生效 →
   收尾前先把焦点点回面板（T2 仍然独立验证「Esc 关闭 + 焦点恢复入口」）。
7. **T6/T8/T10 的任务数**：因为 T7 拆成两条，任务序号不变（T6=1、T7b=2、T8=3、T10=4），保持原期望。

## 5. 发现的问题（含最小复现）

### 5.1 文档与 UI 文案不一致（影响 e2e，非功能缺陷）

- 位置：`docs/api.md:27`「面板向用户展示：`received→已接收`、`processing/archiving→处理中`、
  `archived→已归档`、`failed/needs_review→失败（已记录，可在管理页处理）」；
  实现：`packages/web/src/element.ts:1229` `renderStatus('已保存，正在整理')`、
  `element.ts:1633` `反馈已归档。感谢你的支持！`、`element.ts:1659` `原话已保存，后台整理未完成…`。
- 复现：`grep -rn "已接收" packages/web/src` → 只有注释（`element.ts:65`）；面板文本永不含 `已接收`。
- 影响：旧 e2e 等 `已接收` 永远等不到（20s 超时）；不是产品 bug，而是文案/文档不同步。
  我按 `README §提交流程` 的「201/200 后清空」重写了等待条件；**是否统一文案由 reviewer 决定**。

### 5.2 e2e mock 缺图文归档端点（真实的测试盲区，已补）

- 现象：任何**带截图**的提交在 mock 环境下必然 `failed`：
  `Kaneo 获取评论列表失败 (404)：{"error":"not found"}`（截图评论走的是
  `/task/image-upload/:id` → 预签名 PUT → `/finalize` → `/comment/:taskId` 读写）。
- 影响：修改前 e2e 完全覆盖不到图文归档链路（示例默认 `capture-mode=off`，从未触发过）。
- 处理：在 `e2e/mock-external.mjs` 补齐这套端点（测试替身补齐，不改产品），
  并顺带断言预签名上传地址不携带 Kaneo API Key（`uploadAuthLeaks: []`）。

### 5.3 未发现产品缺陷

三条路径的全部断言（含像素级、失败规则、凭据隔离）在真实浏览器 + 真实服务上通过，
没有发现 `apps/server/**`、`packages/web/**`、`apps/admin/**`、`flutter/**` 的功能性缺陷
（按约束也没有修改这些目录）。

## 6. 明确不可验证 / 未覆盖

- **未覆盖**：`examples/html` 静态示例、Flutter 端（`flutter/feedback`）、管理端 UI 的
  人工操作路径：本次任务只要求三条 Web 路径，未纳入。
- **服务端 PNG 与客户端 PNG 不是同一份字节**（服务端会重新编码/清洗），因此
  「同一份」断言只对浏览器上传字节生效；服务端侧用像素断言（已在 3.2 说明）。
- **P3 的失败注入是测试侧的 DOM 变化**（`data-html2canvas-ignore`），不是产品代码开关；
  它复现的是「真实文档里有可见敏感区、克隆上定位不到」这一真实场景，
  产品侧真实报错 `[locate-failed]` 是内置路径自己抛的。
- **`Esc` 在焦点位于组件外时不关闭面板**：这是 `element.ts:1785` 的有意保护，
  本次没有把它当作缺陷，只在收尾动作里补了「先聚焦再 Esc」。
- 本次仅写入了 `e2e/**`。工作区里 `apps/**`、`packages/**`、`flutter/**`、`docs/**`
  有其它会话/更早改动造成的近期 mtime，与本报告无关（我没有写入这些目录）。

## 7. 改动文件

- 新增：`e2e/browser_paths.py`、`e2e/png_probe.py`、
  `e2e/pages/{orb,mask,maskfail,login,attacker}.html`
- 修改：`e2e/run_browser.py`（启动回退、5189 宿主页托管、第二个服务实例 8788、
  `deps` 接线、第 4 节的期望更新）、`e2e/mock-external.mjs`（AI 调用记录
  `/__mock/ai-calls`、图文归档端点、`uploadAuthLeaks`）
- 运行时产物（每次运行覆盖）：`e2e/shots/*.png`（截图与像素裁剪）、`e2e/pages/leaky.png`
