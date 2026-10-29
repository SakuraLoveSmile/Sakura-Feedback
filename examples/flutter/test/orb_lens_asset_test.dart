import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// T-L3b 资源 bundling：宿主工程必须能按包前缀加载组件包的着色器，
/// 否则 C 路线在宿主端永远退化到 A。
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('宿主按包前缀加载并编译 orb_lens.frag', (WidgetTester tester) async {
    await tester.runAsync(() async {
      final ByteData data = await rootBundle.load(
        'packages/feedback_widget/shaders/orb_lens.frag',
      );
      expect(data.lengthInBytes, greaterThan(0), reason: '着色器资源未随包打包');

      final ui.FragmentProgram program = await ui.FragmentProgram.fromAsset(
        'packages/feedback_widget/shaders/orb_lens.frag',
      );
      final ui.FragmentShader shader = program.fragmentShader();
      expect(shader, isNotNull);
      shader.dispose();
    });
  });
}
