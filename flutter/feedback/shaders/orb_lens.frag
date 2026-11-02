#version 460 core
#include <flutter/runtime_effect.glsl>

// All geometry is logical pixels; uScale alone converts into capture pixels.
uniform vec2 uImageSize;
uniform vec2 uOffset;
uniform float uScale;
uniform vec2 uCenter;
uniform float uRadius;
uniform vec2 uDirection;
uniform float uDeform;
uniform float uWobble;
uniform float uMagnification;
uniform float uRimStrength;
uniform float uOpacity;
uniform vec2 uLocalSize;
uniform float uDark;
uniform vec2 uHalfSize;
uniform float uHandleMix;
uniform float uMist;
uniform float uIdleMix;
uniform sampler2D uBg;
out vec4 fragColor;

// GLSL pow(x, 2) is undefined for negative x on several runtime backends.
// Multiplication preserves the reference Gaussian on both sides of its peak.
float gaussian(float value) { return exp(-value*value); }

vec4 sampleLens(vec2 logical) {
    vec2 uv = clamp(logical * uScale, vec2(.5), uImageSize - vec2(.5)) / uImageSize;
#if defined(IMPELLER_TARGET_OPENGLES) && !defined(IMPELLER_OPENGLES_UNFLIPPED_DEPRECATED)
    uv.y = 1.0 - uv.y;
#endif
    return texture(uBg, uv);
}

// Bounded 5x5 approximation, averaging premultiplied RGBA before any
// unpremultiplication. Every tap uses the same safe sampler and GLES mapping.
float blurWeight(int index) {
    if (index == 0 || index == 4) return .05449;
    if (index == 1 || index == 3) return .24420;
    return .40262;
}
vec4 sampleGlass(vec2 logical) {
    vec4 sharp = sampleLens(logical);
    if (uMist <= 0.0) return sharp;
    vec4 soft = vec4(0.0);
    for (int y = 0; y < 5; y++) {
        for (int x = 0; x < 5; x++) {
            vec2 delta = vec2(float(x-2),float(y-2))*5.0;
            soft += sampleLens(logical+delta)*blurWeight(x)*blurWeight(y);
        }
    }
    return mix(sharp,soft,clamp(uMist,0.0,1.0));
}

// Solve r=1 along a world-space ray using the original q-space formula.
float shape(float theta) {
    vec2 axis = length(uDirection) > .000001 ? normalize(uDirection) : vec2(1.0,0.0);
    vec2 ray = vec2(cos(theta),sin(theta));
    float stretch = 1.0+uDeform*.20;
    vec2 q = vec2(dot(ray,axis)/stretch,dot(ray,vec2(-axis.y,axis.x))*sqrt(stretch));
    float a = atan(q.y,q.x);
    float contour = 1.0+uDeform*(.045*cos(3.0*a)-.035*cos(a))
                       +uWobble*.028*cos(2.0*a+.7);
    return contour/length(q);
}

void main() {
    vec2 p = FlutterFragCoord().xy + uOffset;
    vec2 delta = p - uCenter;
    float angle = length(delta) < .000001 ? 0.0 : atan(delta.y, delta.x);
    float contour = shape(angle);
    float stem = max(0.0,uHalfSize.y-uHalfSize.x);
    vec2 capsuleOffset = vec2(delta.x,delta.y-clamp(delta.y,-stem,stem));
    float capsuleR = length(capsuleOffset)/uHalfSize.x;
    float r = mix(length(delta)/(uRadius*contour),capsuleR,uHandleMix);
    vec2 lensOffset = mix(delta,capsuleOffset,uHandleMix);
    float surfaceAngle = atan(lensOffset.y,lensOffset.x+.00001);
    float aa = mix(1.1/uRadius,.65/min(uHalfSize.x,uHalfSize.y),uIdleMix);
    float inside = 1.0-smoothstep(1.0-aa,1.0+aa,r);
    float rr = clamp(r,0.0,1.0);
    float bend = 1.0/uMagnification+.54*pow(rr,7.0);
    vec2 source = uHandleMix == 0.0 ? uCenter+delta*bend : p+lensOffset*(bend-1.0);
    vec2 ray = normalize(lensOffset+vec2(.001));
    float dispersion = .52*pow(rr,8.0);
    vec4 base = sampleGlass(source);
    vec4 redSample = sampleGlass(source+ray*dispersion);
    vec4 blueSample = sampleGlass(source-ray*dispersion);
    // Unpremultiply each channel's sample before returning premultiplied output.
    vec3 glass = vec3(redSample.a > .00001 ? redSample.r/redSample.a : 0.0,
                      base.a > .00001 ? base.g/base.a : 0.0,
                      blueSample.a > .00001 ? blueSample.b/blueSample.a : 0.0);
    float theta = uHandleMix == 0.0 ? angle : surfaceAngle;
    float light = .55+.45*cos(theta+2.25);
    float rimWidth = mix(.012,.55/uHalfSize.x,uHandleMix);
    float rimPosition = mix(.992,1.0-.35/uHalfSize.x,uHandleMix);
    float rim = gaussian((r-rimPosition)/rimWidth);
    float inner = gaussian((r-.943)/.030);
    float caustic = gaussian((r-.84)/.095)*(.5+.5*sin(theta-.6));
    float shadow = gaussian((r-.973)/.018)*(1.0-light);
    glass *= 1.0-shadow*.19*(1.0-uIdleMix);
    float whiteMix = (rim*(.28+.5*light)*uRimStrength+inner*.10*light+caustic*.12)*(1.0-uIdleMix);
    glass = mix(glass,vec3(.99,.995,1.0),whiteMix);
    float haze = uMist*(.045+.035*uDark)*uIdleMix;
    glass = mix(glass,vec3(.965,.98,1.0),haze);
    float sheen = gaussian((r-.91)/.065)*pow(max(0.0,cos(surfaceAngle+2.25)),8.0)
                  *(.05+.04*uHandleMix)*uIdleMix;
    glass = mix(glass,vec3(1.0),sheen);
    // The reference's opaque framebuffer clamps highlights to display range.
    // Clamp before premultiplication so the tint cannot make RGB exceed alpha.
    glass = clamp(glass+vec3(.002,.003,.009)*(1.0-uDark*.5),vec3(0.0),vec3(1.0));
    float lightIdle = uIdleMix*(1.0-uDark);
    float glowWidth = mix(mix(.065,.14,uIdleMix),4.5/mix(uRadius,uHalfSize.x,uHandleMix),lightIdle);
    float glowStrength = mix(mix(.055,.10,uIdleMix),.18,lightIdle);
    vec3 glowColor = mix(vec3(.95,.965,1.0),vec3(.35,.43,.56),lightIdle);
    float outerGlow = gaussian((r-1.04)/glowWidth)*glowStrength;
    // The reference background is opaque. Preserve the safe snapshot's alpha
    // for transparent hosts while keeping the outer glow independent.
    float surfaceAlpha = inside*base.a;
    float glowAlpha = outerGlow*(1.0-inside)*(1.0-inside);
    float alpha = (surfaceAlpha+glowAlpha)*uOpacity;
    fragColor = vec4((glass*surfaceAlpha+glowColor*glowAlpha)*uOpacity,alpha);
}
