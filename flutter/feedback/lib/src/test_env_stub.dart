/// Web / 无 `dart:io` 环境：恒为 false——真实运行环境不存在
/// `FLUTTER_TEST` 注入，光晕等常驻动画照常运行。
/// （`flutter test --platform chrome` 下无法读取环境变量，按真实环境处理。）
const bool kFeedbackInFlutterTest = false;
