// The source radius first increases with the screen radius, then folds back
// near the rim. The reflected strip therefore follows the sampled content.
float gestureGlassBend(float r) {
    float fold = smoothstep(.60, 1.0, r);
    // Without the mirrored band the source radius stays increasing all the
    // way to the silhouette. Both profiles share the same central lens.
    return .92 + mix(.08, -.60, uEdgeReflection) * fold * fold;
}

// Compose in premultiplied space so a transparent/missing host texture
// contributes only the reflection, the narrow silhouette and its shadow.
vec4 gestureGlassSurface(vec4 sampleColor, float r, vec2 ray, float radius, float inside) {
    float edgePx = (r - 1.0) * radius;
    float light = .5 + .5 * dot(ray, vec2(.60, .80));
    float rim = exp(-pow(abs(edgePx + .9) / 1.2, 2.0));
    float shoulder = exp(-pow(abs(r - .91) / .055, 2.0));
    float reflection = inside * (rim * .24 + uEdgeReflection * (rim * .54 + shoulder * .12) * light);
    float shade = inside * rim * (.18 + .28 * (1.0-light));
    float shadow = (1.0-inside) * .20 * exp(-pow(max(edgePx,0.0) / 2.6, 2.0));
    vec4 body = sampleColor * inside;
    body = vec4(0.0, 0.0, 0.0, shade) + body * (1.0-shade);
    body = vec4(vec3(reflection), reflection) + body * (1.0-reflection);
    return body + vec4(0.0, 0.0, 0.0, shadow) * (1.0-body.a);
}

// Coordinate system is centered on the gesture. Geometry is measured in
// final radii, except for bead whose painter already scales the drawing box.
struct EntranceGlass {
    vec2 sampleDelta;
    vec2 ray;
    float radial;
    float edgeRadius;
    float visibility;
    float glint;
};
float entranceBell(float x) { return exp(-x*x); }
EntranceGlass entranceGlass(vec2 delta, float radius, float restingR,
                            float id, float t, vec2 fingerAxis) {
    vec2 p = delta / radius;
    vec2 optical = p;
    vec2 normal = p;
    float r = restingR, scale = 1.0, strength = 1.0;
    float mask = 1.0, glint = 0.0, dimple = 0.0;
    vec2 shift = vec2(0.0);
    if (t < 1.0) {
        if (id < .5) {
            float flattening = 1.0 + .44*(1.0-smoothstep(0.0,.5625,t));
            normal = p*vec2(1.0/flattening,flattening);
            r = length(normal);
            strength = .40+.60*smoothstep(0.0,.70,t);
        } else if (id < 1.5) {
            float gather = smoothstep(0.0,.85,t);
            vec2 gap = fingerAxis*(1.0-gather);
            scale = .17+.85*gather-.02*smoothstep(.85,1.0,t);
            float a = length(p+gap), b = length(p-gap);
            float k = max(.00001,.27*sin(3.14159*gather));
            float w = clamp(.5+.5*(a-b)/k,0.0,1.0);
            r = (mix(a,b,w)-k*w*(1.0-w))/scale;
            optical = p-gap*(2.0*w-1.0);
            normal = optical;
        } else if (id < 2.5) {
            float crossAxis = dot(p,vec2(.54,-.84));
            float front = -1.0+2.50*smoothstep(0.0,1.0,t)
                        -dot(p,vec2(.84,.54))-.21*crossAxis*crossAxis;
            mask = smoothstep(-.19,.21,front);
            glint = .28*entranceBell(front/.085)*(1.0-smoothstep(.82,1.0,t));
        } else if (id < 3.5) {
            float rise = smoothstep(92.0,281.0,t*335.0);
            float depth = (.30+.70*smoothstep(0.0,89.0,t*335.0))*(1.0-rise);
            scale = .75+.268*rise-.018*smoothstep(282.0,335.0,t*335.0);
            r = length(p)/scale;
            dimple = depth*.65*(1.0-smoothstep(.18,1.0,r));
            normal *= 1.0-2.0*depth;
            strength = rise;
            glint = depth*.15*entranceBell((r-.76)/.12);
        } else if (id < 4.5) {
            float angle = mix(.036,1.5707963,smoothstep(0.0,1.0,t));
            float side = cos(angle), face = sin(angle), lean = -.22*side;
            vec2 axis = vec2(cos(lean),sin(lean));
            normal = vec2(dot(p,axis)/face,dot(p,vec2(-axis.y,axis.x)));
            r = length(normal);
            scale = max(r,.0001)/max(length(normal*vec2(1.0/face,1.0)),.0001);
            shift = side*face*.27*(1.0-smoothstep(0.0,1.0,r))*axis;
            glint = side*.66*entranceBell((normal.x-.36*side)/(.14+.36*side));
        } else if (id < 5.5) {
            float ms = t*340.0;
            vec2 axis = vec2(.64,-.7684);
            float lift = 1.04*smoothstep(0.0,123.0,ms)*(1.0-smoothstep(123.0,328.0,ms));
            scale = .13+.89*smoothstep(0.0,269.0,ms)-.02*smoothstep(270.0,340.0,ms);
            optical = p-axis*lift;
            normal = optical/max(length(optical),.0001);
            float back = max(0.0,-dot(normal,axis));
            scale += max(0.0,lift-scale)*back*back*exp(-3.4*abs(dot(normal,vec2(-axis.y,axis.x))));
            r = length(optical)/scale;
        } else {
            float ms = t*280.0;
            float unfold = smoothstep(40.0,245.0,ms);
            scale = .63+.37*smoothstep(0.0,242.0,ms);
            float corner = scale*(.16+.84*unfold*unfold);
            vec2 q = abs(p)-vec2(scale-corner);
            r = 1.0+(length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0)-corner)/scale;
            mask = mix(smoothstep(.45,.64,min(abs(p.x),abs(p.y))/scale),1.0,unfold);
            strength = smoothstep(55.0,250.0,ms);
        }
    }
    EntranceGlass field;
    field.sampleDelta = delta + radius*(optical*(strength*(gestureGlassBend(r)-1.0)+dimple)+shift);
    field.ray = normal/max(length(normal),.0001);
    field.radial = max(0.0,r);
    field.edgeRadius = max(.1,scale*radius);
    field.visibility = mask;
    field.glint = glint;
    return field;
}

vec4 entranceSurface(EntranceGlass field, vec4 sampled, float inside) {
    vec4 glass = gestureGlassSurface(sampled,field.radial,field.ray,field.edgeRadius,inside)*field.visibility;
    float highlight = inside*field.glint;
    return vec4(vec3(highlight),highlight) + glass*(1.0-highlight);
}
