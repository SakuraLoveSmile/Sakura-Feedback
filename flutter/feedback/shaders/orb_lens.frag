#version 460 core
#include <flutter/runtime_effect.glsl>

// C 路线透镜：单次捕获的宿主背景 + 七点径向放大表。
// uBg 是捕获图像；uOffset / uScale 把绘制坐标换成图像像素；
// uCenter / uRadiusPx 是图像像素下的球心与透镜半径；
// uStretch / uAngle 描述拖动拉伸后的玻璃椭圆：半长轴 = uRadiusPx * uStretch，
// 方向沿拖动角 uAngle。半径判定必须用椭圆，否则球缘会露出未放大的背景。
// uDispersion 是球缘处的 B−R 总位移（相对半径），按 r² 沿径向展开。
uniform vec2 uImageSize;
uniform vec2 uOffset;
uniform float uScale;
uniform vec2 uCenter;
uniform float uRadiusPx;
uniform float uStretch;
uniform float uAngle;
uniform float uDispersion;
uniform sampler2D uBg;

out vec4 fragColor;

// 与 orbLensMagnification 同口径：先钳制到 [0,1]，再按七个采样点分段线性
// 插值。运行时 SkSL 不接受文件作用域常量数组的下标访问，这里展开成分支。
float lensMagnification(float r) {
    float t = clamp(r, 0.0, 1.0);
    if (t <= 0.25) {
        return mix(1.700, 1.698, t / 0.25);
    }
    if (t <= 0.50) {
        return mix(1.698, 1.671, (t - 0.25) / 0.25);
    }
    if (t <= 0.70) {
        return mix(1.671, 1.577, (t - 0.50) / 0.20);
    }
    if (t <= 0.85) {
        return mix(1.577, 1.401, (t - 0.70) / 0.15);
    }
    if (t <= 0.95) {
        return mix(1.401, 1.173, (t - 0.85) / 0.10);
    }
    return mix(1.173, 0.866, (t - 0.95) / 0.05);
}

void main() {
    vec2 local = FlutterFragCoord().xy;
    vec2 image = uOffset + local * uScale;
    vec2 delta = image - uCenter;

    // 旋到拖动帧后按椭圆归一化：长轴（拖动方向）除以 R * Stretch，短轴除以 R。
    float c = cos(uAngle);
    float s = sin(uAngle);
    vec2 lens = vec2(c * delta.x + s * delta.y, -s * delta.x + c * delta.y);
    float radius = length(vec2(lens.x / (uRadiusPx * uStretch), lens.y / uRadiusPx));
    if (radius > 1.0) {
        fragColor = vec4(0.0);
        return;
    }
    // 按 r / M(r) 取源点：中心放大、球缘压缩。
    vec2 base = uCenter + delta / lensMagnification(radius);
    if (radius <= 0.0) {
        // 球心没有径向方向：直接单次采样，避免除零。
        fragColor = texture(uBg, base / uImageSize);
        return;
    }
    // 径向分通道色散：R 向球心、B 向球缘各偏半个位移，G 居中；
    // 单通道偏移 = 0.5 × Dispersion × r² × R（图像像素），alpha 不变。
    vec2 radial = delta / length(delta);
    float shift = 0.5 * uDispersion * radius * radius * uRadiusPx;
    vec4 centerSample = texture(uBg, base / uImageSize);
    float red = texture(uBg, (base - radial * shift) / uImageSize).r;
    float blue = texture(uBg, (base + radial * shift) / uImageSize).b;
    fragColor = vec4(red, centerSample.g, blue, centerSample.a);
}
