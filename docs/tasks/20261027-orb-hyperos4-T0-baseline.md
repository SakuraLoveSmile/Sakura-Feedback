# T0 基线 · 灵感球 HyperOS 4 改造前快照

- 记录时间：2026-10-27 14:50–15:05（本地时区 +08:00）
- 执行人：测试验证工程师
- 范围：只读摸底 + 本文件 + `e2e/shots/orb-baseline/` 四张截图；未改动任何业务代码、测试或 WIP
- 目标状态（对照）：Web + Flutter 统一，静止 56px、拖动 76px

## 1. 工作区基线

| 项 | 值 |
| --- | --- |
| HEAD | `ccd99b79f9aaa37f10489945818200f6e7a97944` |
| `git status --short` 条目数 | **247**（89 modified + 158 untracked 目录/文件条目） |
| `git diff --stat` | **89 files changed, 23676 insertions(+), 4799 deletions(-)** |
| 全量未跟踪文件（展开） | **965** 个（`git ls-files --others --exclude-standard`，清单见 `/tmp/orb-T0-untracked.txt`） |
| WIP 补丁 | `/tmp/orb-T0-wip.patch`，1,513,562 字节，sha256 `4d7b7aa5b06c581adc525847b400f0ba9e5d2e96d9b51e05c1ca4b018d498303` |

说明：

- 补丁只包含 **89 个已跟踪文件的修改**；未跟踪的 965 个文件（含灵感球相关新文件与历史截图）不在 `git diff` 里，回滚时必须以 965 个未跟踪文件为参照，不能只靠补丁。
- 未跟踪清单按目录分布：`e2e/shots` 913、`flutter/feedback` 17、`packages/web` 16、`apps/server` 8、`e2e/pages` 3，其余为 e2e 脚本等散件。
- 未做 `stash` / `checkout` / `reset` / `clean`，未提交。

## 2. Web 检查（基线全绿）

命令与结果（原样执行，均在 `packages/web`）：

| 命令 | 结果 |
| --- | --- |
| `npx vitest run` | ✅ **27 个测试文件 / 337 个用例全部通过**，Duration 4.87s（transform 1.25s / tests 17.78s / environment 9.19s） |
| `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0，无输出 |
| `npx eslint .` | ✅ exit 0，无输出 |

与规划者给出的已知基线（27 文件 / 337 用例）一致，无预先存在的失败项。

## 3. Flutter 检查（被环境阻塞，未跑出用例）

命令：`cd flutter/feedback && ~/devsdk/flutter/bin/flutter test --no-pub`

结果：**exit 1，0 通过 / 26 个测试文件全部在加载阶段编译失败**（`+0 -26`）。测试代码本身没有失败——是依赖解析指向了 pub cache 里不存在的目录：

```
Error: Error when reading '~/.pub-cache/hosted/pub.dev/vector_math-2.4.3/lib/vector_math_64.dart': No such file or directory
Error: Error when reading '~/.pub-cache/hosted/pub.dev/meta-1.19.0/lib/meta.dart': No such file or directory
```

后续连锁报错 `The getter 'Matrix4' isn't defined`、`Undefined name 'visibleForTesting'` 都是这两个缺失包导致的。

诊断证据：

- `.dart_tool/package_config.json`（2026-10-13 11:34 生成）与 `pubspec.lock` 一致，锁定 `vector_math 2.4.3`、`meta 1.19.0`、`leak_tracker 11.0.2`；
- pub cache 实际只有 `vector_math-2.2.0`、`vector_math-2.4.0`、`meta-1.17.0`、`meta-1.18.3`；
- 逐个校验 80 个依赖的 rootUri：**20 个目录不存在**（vector_math、meta、flutter_lints、flutter_secure_storage 全家、url_launcher_ios/linux/macos/windows、lints、pub_semver、win32、yaml、js、package_config、jni_flutter）；
- 工具链为 Flutter 3.47.7 / Dart 3.13.5（比 lock 生成时的解析更新），pub cache 未同步；
- 已尝试的下一步 `flutter pub get` 被本卡策略拦截，**未执行**（T0 只读，且该命令会触碰 `pubspec.lock`/依赖）。`pub.dev` HTTPS 探测正常（HTTP 200，1.5s）。

结论：**Flutter 基线的「通过/失败数」本卡无法取得**，仅能确认「26 个测试文件因缺依赖全部无法加载」。需要一张解锁卡执行 `flutter pub get`（或补齐 pub cache），之后重跑同一条命令。本卡未修改 `pubspec.yaml` / `pubspec.lock`。

## 4. 观感基线截图

目录：`e2e/shots/orb-baseline/`

| 文件 | 主题 | 状态 |
| --- | --- | --- |
| `light-static.png` | 浅色（默认宿主页白底） | 静止 |
| `light-dragging.png` | 浅色 | 拖动中 |
| `dark-static.png` | 深色 | 静止 |
| `dark-dragging.png` | 深色 | 拖动中 |

采集方式（可复现）：

- 环境：`python3 e2e/preview.py --no-examples`，端口 5189（宿主页）/ 8787（反馈服务）/ 8898、8899（外部 mock），临时数据目录 `FEEDBACK_DATA_DIR=$TMPDIR/fb-preview-vf14wll5`（未复用真实数据目录）；页面 `http://localhost:5189/orb.html`。
- 组件产物为 `packages/web/dist/feedback-web.umd.cjs`（2026-10-15 20:02 构建），已核对其中 `.fb-orb` 样式与当前 `src/styles.ts` 一致（48px 静止、拖动 scale 1.5、`is-dragging` 去过渡）。
- 浏览器：Playwright + 系统 Chrome（headless）；viewport 1280×800，**deviceScaleFactor=2**，`screenshot(animations="disabled")` 冻结 7s 光晕旋转动画，保证可复现。
- 裁剪窗口：页面右下角固定 300×300 CSS px（`x=980, y=402`，避开视口右边界以免裁掉光晕），输出 **600×600** 像素；四张使用同一裁剪框，拖动态球心偏移 (-40,-26) 仍在框内。
- 深色态：`color_scheme="dark"` + 注入 `html,body{background:#0e0e12}`（仅运行时注入，不落仓库）；组件未设置 `theme` 属性，走 `prefers-color-scheme` 分支。
- 拖动态：在球心按下 → 移动 (-40, -26)（超过 8px 阈值）→ **保持按下**截图，之后松开。断言到 `is-dragging` 类为 true。

实测尺寸证据（渲染时读 computed style）：

| 状态 | 当前实现 | 目标 |
| --- | --- | --- |
| 静止 | `48 × 48 px`，`transform: none`，透明底色，边框 `rgba(125,125,130,.35)`（深色 `rgba(255,255,255,.22)`） | 56px |
| 拖动 | CSS 盒仍 48px，`transform: matrix(1.5,0,0,1.5,-40,-26)` → 视觉 **72px** | 76px |

即改造前是 48→72（scale 1.5）；目标 56→76（scale ≈1.357）意味着尺寸与缩放系数都要改。

## 5. 未验证项与风险

- **Flutter 基线：被阻塞**（缺 20 个 pub 包；`flutter pub get` 待解锁）。Flutter 端观感（56/76）本卡未截图、未验证。
- **Flutter 视觉效果未验证**：本卡只采集 Web 截图；Flutter 需要设备/模拟器，未启动。
- 截图来自 `dist` 构建产物而非 Vite dev server；已核对 CSS 与源码一致，但如果后续有人手改 `dist` 而不改源码，基线会失真。
- 宿主页 `orb.html` 控制台有一条 404（未抓到具体 URL，404 不影响灵感球渲染；疑似 favicon）。
- 光晕动画已冻结。若后续任务关心动画手感（旋转速度、模糊半径），本基线不覆盖动态效果。
- `e2e/shots` 下 913 个历史截图未跟踪，工作区噪声大，后续比对时请只认 `orb-baseline/` 四个文件。

## 6. WIP 完整性自检

- 本卡新增内容：本文件 + `e2e/shots/orb-baseline/*.png`（4 个），均为新文件。
- 已跟踪文件零改动：结束后重算 `git diff` 写入 `/tmp/orb-T0-wip-after.patch`，sha256 与开工前补丁完全相同（`4d7b7aa5…d498303`）→ `TRACKED_DIFF_IDENTICAL`。
- `git status --short` 条目数 247 → 249，增量仅 `?? docs/tasks/`、`?? e2e/shots/orb-baseline/` 两个新目录；HEAD 仍为 `ccd99b7`。
- 未提交、未 stash、未 checkout、未清理任何 WIP；`flutter/feedback/pubspec.lock` 与 `.dart_tool` 保持原样（备份在 `/tmp/orb-T0-pubspec.lock.bak`、`/tmp/orb-T0-package_config.json.bak`）。
- 预览环境已停止（`kill $(cat /tmp/fb-preview.pid)`），端口已释放。

2026-10-27 后续规格修订：灵感球静止 56px、拖动 84px（scale 1.5），见 docs/orb-spec.md；本文 76px 为目标快照，不是最终值。
