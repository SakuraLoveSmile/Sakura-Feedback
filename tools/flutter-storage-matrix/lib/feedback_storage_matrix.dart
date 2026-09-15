/// flutter_secure_storage 9/10/11 三版本隔离矩阵宿主（仅用于测试，不导出组件 API）。
///
/// 组件包 `feedback_widget` 的依赖约束是 `>=9.2.2 <12.0.0`，但“能解析”不等于
/// “三个版本都跑得对”。宿主的作用就是在**同一份组件测试源码**上，把插件固定到
/// 9.2.2 / 10.3.1 / 11.0.0 三个精确版本分别跑一遍：
///
/// - 宿主通过 path 依赖引用 `flutter/feedback`，所以跑的是本工作区的实现；
/// - 版本固定只用普通版本约束（由 `run.sh` 改写），全程不使用 dependency_overrides；
/// - 复用的用例来自 `flutter/feedback/test`，由 `run.sh` 同步到 `test/feedback/`，
///   避免两处维护同一批断言。
library;

/// 矩阵覆盖的档位，与 `run.sh` 的默认参数和 `check_tier.py` 的 TIER_RULES 一致。
const List<String> matrixTiers = <String>['9.2.2', '10.3.1', '11.0.0'];

/// 组件包约束允许的插件版本区间（来源：flutter/feedback/pubspec.yaml）。
const String supportedSecureStorageRange = '>=9.2.2 <12.0.0';
