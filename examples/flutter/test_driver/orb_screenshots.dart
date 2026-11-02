import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

Future<void> main() async {
  final Directory output = Directory(
    Platform.environment['FB_ORB_SCREENSHOTS'] ?? 'build/orb-screenshots',
  );
  await output.create(recursive: true);
  await integrationDriver(
    writeResponseOnFailure: true,
    onScreenshot:
        (String name, List<int> bytes, [Map<String, Object?>? args]) async {
          await File('${output.path}/$name.png').writeAsBytes(bytes);
          return bytes.isNotEmpty;
        },
  );
}
