#version 460 core
#include <flutter/runtime_effect.glsl>

// C 路线透镜：单次捕获的宿主背景 + 七点径向放大表。
// uBg 是捕获图像；uOffset / uScale 把绘制坐标换成图像像素；
// uCenter / uRadiusPx 是图像像素下的球心与透镜半径。
uniform vec2 uImageSize;
uniform vec2 uOffset;
uniform float uScale;
uniform vec2 uCenter;
uniform float uRadiusPx;
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
    float radius = length(delta) / uRadiusPx;
    if (radius > 1.0) {
        fragColor = vec4(0.0);
        return;
    }
    // 按 r / M(r) 取源点：中心放大、球缘压缩，不做 RGB 分通道色散。
    vec2 source = uCenter + delta / lensMagnification(radius);
    fragColor = texture(uBg, source / uImageSize);
}
