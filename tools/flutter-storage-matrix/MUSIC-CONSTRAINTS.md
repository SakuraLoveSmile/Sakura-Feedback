# Music（sakuramusic）侧约束来源记录

本文件记录「11 档要检查哪些约束、为什么」的**来源**。所有数字都取自实际文件，
不是猜测；每一条都给出文件路径与行号，`check_tier.py --music <dir>` 可在有 Music
检出时重新核对（CI 上通常没有 Music 源码，此时脚本会显式记录“跳过”，不会假装通过）。

## 1. Music 对插件的声明

| 事实 | 来源 |
| --- | --- |
| `flutter_secure_storage: ^11.0.0` | `Music/pubspec.yaml:71` |
| 实际解析到 `flutter_secure_storage 11.0.0`（sha256 `15e8c8fe269fdf7d469b23008ab3df521c8b826ed345820532364c31bdebace6`） | `Music/pubspec.lock:414-419` |
| Music 自身 Dart 下限 `sdk: ^3.11.1` | `Music/pubspec.yaml:25` |

## 2. 从 11.0.0 继承的硬要求（插件包自身元数据）

这些都是 `flutter_secure_storage 11.0.0` 自己的声明，凡是使用 ^11.0.0 的宿主都必须满足：

| 要求 | 来源 |
| --- | --- |
| Dart `>=3.8.0`（`environment.sdk`） | `flutter_secure_storage-11.0.0/pubspec.yaml`（pub cache，即本机 `~/.pub-cache/hosted/pub.dev/`；矩阵宿主通过 `.dart_tool/package_config.json` 定位实际目录） |
| Android `minSdk = 24` | `flutter_secure_storage-11.0.0/android/build.gradle:30` |
| Android `compileSdk = 37` | `flutter_secure_storage-11.0.0/android/build.gradle:22` |
| `flutter_secure_storage_darwin` 取代 `_ios`/`_macos` | 11.0.0 的 `flutter.plugin.platforms`（darwin 作为 iOS/macOS 的 default_package）；矩阵 11 档解析出 `flutter_secure_storage_darwin`，而 `flutter_secure_storage_macos` 不再出现 |
| `flutter_secure_storage_windows` 主版本 4 | `Music/pubspec.lock:454-459` → `4.2.2`；矩阵 10.3.1 / 11.0.0 档同样解析出 `4.2.2`（9.2.2 档为 `3.1.2`） |

## 3. Music 的 Android 侧现状（如实记录，供宿主对照）

| 事实 | 来源 |
| --- | --- |
| Music 没有显式写 compileSdk/minSdk，直接继承 Flutter 默认值 | `Music/android/app/build.gradle.kts:12`（`compileSdk = flutter.compileSdkVersion`）、`:56`（`minSdk = flutter.minSdkVersion`） |
| 本机 Flutter 3.41.3 的默认值是 `compileSdkVersion = 36`、`minSdkVersion = 24`、`targetSdkVersion = 36` | `$HOME/flutter/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt:23/26/34` |

推论（同样有来源、不是猜测）：11.0.0 的 Android 库模块以 `compileSdk 37` 编译，
AGP 会要求消费方应用也编译到 `>= 37`；而 Music 在 Flutter 3.41.3 下继承到 36。
因此**示例 app 必须显式提升 compileSdk 到 37**（本任务已在
`examples/flutter/android/app/build.gradle.kts` 落实），Music 自身若要在该 Flutter
版本上构建 Android 也需要同样的提升——这一点属于 Music 仓库，不在本任务范围内，
仅作为来源记录在此。

## 4. 矩阵里的对应检查

`check_tier.py` 在 `--tier 11.0.0` 时逐条断言：解析出的插件版本为 11.0.0、
`darwin` 存在且 `_macos` 消失、`windows` 主版本为 4、插件 `environment.sdk` 下限
`>=3.8.0`、当前 Dart 满足该下限、插件 Android `compileSdk == 37` / `minSdk == 24`；
并在传了 `--example-gradle` 时断言示例 app 显式 `compileSdk = 37` 且 `minSdk >= 24`。
