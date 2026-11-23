// Flutter and WebGL both pass the crest radius in the touch point's logical coordinate space.
vec4 waterSurface(vec2 point, vec2 size, vec2 origin, float crestRadius, float seconds, float dim) {
    float unit = min(min(size.x, size.y) / 361.0, 1.6);
    vec2 ray = (point - origin) / unit;
    float distanceFromTouch = length(ray);
    float radius = crestRadius / unit;
    if (radius < 0.1 || distanceFromTouch < 0.4 || seconds >= 1.8)
        return vec4(0.0);

    // A tiny wave starts at the touch. Its width grows with travel, leaving the
    // page behind it still, even when the touch is close to a screen edge.
    float width = min(radius * 0.18, clamp(radius * 0.038, 1.8, 9.0));
    float phase = (distanceFromTouch - radius) / width;
    if (abs(phase) > 9.0) return vec4(0.0);

    vec2 direction = ray / distanceFromTouch;
    float turn = seconds * 1.04719755;
    vec2 axis = vec2(sin(turn), -cos(turn));
    float angle = acos(clamp(abs(dot(axis, direction)), 0.0, 1.0));
    float highlight = 1.0 - smoothstep(0.0, 1.134464, angle);
    float arcFloor = mix(0.62, 0.22, smoothstep(0.0, 85.0, radius));
    float envelope = smoothstep(0.0, 0.13, seconds) * (1.0 - smoothstep(0.55, 1.8, seconds));
    float amplitude = 1.42 * envelope * mix(arcFloor, 1.0, highlight);
    float separation = min(3.3 / width, 0.65);
    vec3 phases = phase + vec3(-separation, 0.0, separation);
    vec3 slope = amplitude * sin(phases) * exp(-phases * phases / 14.0);

    // Express displacement in page pixels. A fingertip-sized wave can only
    // bend nearby content, regardless of the screen's aspect ratio.
    float bend = unit * min(radius * 0.32, width * 4.6);
    vec2 uv = (point + direction * (bend * slope.g)) / size;
    vec3 surface = readWater(clamp(uv, 0.0, 1.0));
    vec3 shaded = mix(surface, vec3(99.0, 93.0, 146.0) / 255.0, dim) + slope * 0.2;
    return vec4(clamp(shaded, 0.0, 1.0), 1.0);
}
