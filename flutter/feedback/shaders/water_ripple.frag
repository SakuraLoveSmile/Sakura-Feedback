#version 460 core
#include <flutter/runtime_effect.glsl>

uniform vec2 uSize;
uniform vec2 uOrigin;
uniform float uSeconds;
uniform float uDim;
uniform vec2 uImageSize;
uniform float uRadius;
uniform sampler2D uFrozen;
out vec4 fragColor;

vec3 texelColor(vec2 pixel) {
    vec2 uv = (clamp(pixel, vec2(0.0), uImageSize - 1.0) + 0.5) / uImageSize;
#if defined(IMPELLER_TARGET_OPENGLES) && !defined(IMPELLER_OPENGLES_UNFLIPPED_DEPRECATED)
    uv.y = 1.0 - uv.y;
#endif
    return texture(uFrozen, uv).rgb;
}

// Older supported Flutter engines expose only nearest sampling here.
vec3 readWater(vec2 uv) {
    vec2 texel = uv * uImageSize - 0.5;
    vec2 base = floor(texel), f = fract(texel);
    return mix(mix(texelColor(base), texelColor(base + vec2(1.0, 0.0)), f.x),
               mix(texelColor(base + vec2(0.0, 1.0)), texelColor(base + 1.0), f.x), f.y);
}

#include "water_field.glsl"

void main() {
    fragColor = waterSurface(FlutterFragCoord().xy, uSize, uOrigin, uRadius, uSeconds, uDim);
}
