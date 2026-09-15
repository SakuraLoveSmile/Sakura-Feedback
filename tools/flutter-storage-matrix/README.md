# flutter_secure_storage 三版本隔离矩阵

这是**测试宿主**，不是组件包。它存在的唯一目的：把 `feedback_widget` 的依赖
`flutter_secure_storage` 分别固定在 `9.2.2` / `10.3.1` / `11.0.0` 三个精确版本，
在**同一份组件测试源码**上跑 `flutter analyze` + `flutter test`，证明
`flutter/feedback/pubspec.yaml` 里放宽后的约束 `>=9.2.2 <12.0.0` 不只是“能解析”，
而是三档行为都对。

- 通过 path 依赖引用 `../../flutter/feedback`，跑的是本工作区的实现。
- 版本固定只用普通版本约束（由 `run.sh` 改写宿主 pubspec 的那一行），
  **不使用 `dependency_overrides`**；`check_tier.py` 会断言这一点。
- 复用的用例来自 `flutter/feedback/test`，由 `run.sh` 同步到 `test/feedback/`
  （生成物，见 `.gitignore`），并记录每个文件的 sha256，避免两处维护同一批断言。

## 怎么跑

```bash
export PATH="$HOME/flutter/bin:$PATH"
bash tools/flutter-storage-matrix/run.sh                    # 默认三档：9.2.2 10.3.1 11.0.0
bash tools/flutter-storage-matrix/run.sh 11.0.0             # CI 每档一个 job
MATRIX_MUSIC_DIR=~/path/to/Music bash tools/flutter-storage-matrix/run.sh 11.0.0  # 附加 Music 对照
```

每档依次执行：改写固定版本 → `flutter pub get` → 记录实际解析到的插件与
federated 子包版本并校验（`check_tier.py`）→ 同步并运行组件测试 → `flutter analyze`
→ `flutter test`。证据写到 `out/<档位>/`（`pub-get.log`、`analyze.log`、`test.log`、
`check.log`、`resolved.json`、`feedback-test-sha256.txt`），汇总在
`out/matrix-summary.tsv`。无论成败，脚本结束都会把宿主约束还原为
`>=9.2.2 <12.0.0` 并重新 `pub get`。

## 三档的 federated 形态（校验基线）

| 档位 | darwin | macos | windows | platform_interface |
| --- | --- | --- | --- | --- |
| 9.2.2 | 无 | 3.1.3 | 3.1.2 | 1.1.2 |
| 10.3.1 | 0.3.2（取代 `_macos`） | 不再出现 | 4.2.2 | 2.1.0 |
| 11.0.0 | 0.4.2（取代 `_macos`） | 不再出现 | 4.2.2 | 2.1.0 |

表里的具体小版本是**一次实际运行的记录**；`check_tier.py` 校验的是家族形态
（主版本与 darwin/macos 的替换关系），具体小版本随 pub 解析记录进 `resolved.json`。

## 11 档的额外检查（与 Music 对齐）

`check_tier.py --tier 11.0.0` 会逐条断言：插件 Dart 下限 `>=3.8.0` 且当前 Dart 满足、
插件 Android `compileSdk == 37` / `minSdk == 24`、`windows` 主版本为 4、
示例 app 显式 `compileSdk = 37` 且 `minSdk >= 24`，并用本机 Flutter 的
`FlutterExtension.kt` 默认值证明“显式提升是必要的”。每条约束的来源见
[`MUSIC-CONSTRAINTS.md`](MUSIC-CONSTRAINTS.md)。

## 卫生

本目录是 Flutter 包模板生成的宿主（`flutter create --template=package`）。
`.gitignore` 忽略 `pubspec.lock`、`out/` 和同步进来的 `test/feedback/`，
因此矩阵的每次运行都可从干净检出复现。
