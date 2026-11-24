// Flutter and WebGL both pass the crest radius in the touch point's logical coordinate space.
vec4 waterSurface(vec2 point, vec2 size, vec2 origin, float crestRadius, float seconds) {
    float unit = min(min(size.x, size.y) / 361.0, 1.6);
    vec2 ray = (point - origin) / unit;
    float distanceFromTouch = length(ray);
    float radius = crestRadius / unit;
    if (radius < 0.1 || distanceFromTouch < 0.4 || seconds >= 1.8)
        return vec4(0.0);

    // A tiny wave starts at the touch. Its width grows with travel, leaving the
    // page behind it still, even when the touch is close to a screen edge.
    float width = min(radius * 0.2, clamp(radius * 0.05, 2.4, 12.0));
    float phase = (distanceFromTouch - radius) / width;
    if (abs(phase) >= 3.5) return vec4(0.0);

    vec2 direction = ray / distanceFromTouch;
    float envelope = smoothstep(0.0, 0.13, seconds) * (1.0 - smoothstep(0.55, 1.8, seconds));
    // The derivative of one rounded crest bends the inner and outer slopes in
    // opposite directions. Both return smoothly to the original page.
    float slope = phase * exp(0.5 * (1.0 - phase * phase));
    float bend = unit * min(width * 0.78, 6.5) * envelope * slope;
    vec2 uv = (point + direction * bend) / size;
    vec4 surface = readWater(clamp(uv, 0.0, 1.0));

    float turn = seconds * 1.04719755;
    float light = dot(direction, vec2(sin(turn), -cos(turn))) * slope * 0.032 * envelope;
    surface.rgb = clamp(surface.rgb + light * surface.a, vec3(0.0), vec3(surface.a));
    return surface * (1.0 - smoothstep(2.0, 3.5, abs(phase))) * envelope;
}
