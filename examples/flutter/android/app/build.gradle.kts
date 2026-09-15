plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "dev.example.feedback_example"
    // 示例固定使用 flutter_secure_storage 11.0.0（见 pubspec.yaml），它的 Android
    // 库模块以 compileSdk = 37 编译（flutter_secure_storage-11.0.0/android/build.gradle:22），
    // 消费方应用必须编译到 >=37，否则 AGP 的 AAR metadata / Flutter Gradle 插件会报
    // “plugin requires Android SDK version 37 or higher”。
    // 本机 Flutter 3.41.3 的默认值是 flutter.compileSdkVersion = 36
    // （packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt:23），
    // 所以这里必须显式提升，而不是沿用默认值。
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "dev.example.feedback_example"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        // flutter_secure_storage 11 要求 minSdk >= 24（11.0.0/android/build.gradle:30）。
        // 本机 Flutter 默认 flutter.minSdkVersion = 24，用 maxOf 兜住下限：
        // 既不会被默认值降到 24 以下，也不会在默认值提高后反向压低它。
        minSdk = maxOf(flutter.minSdkVersion, 24)
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

flutter {
    source = "../.."
}
