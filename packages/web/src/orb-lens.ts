import type { LiquidShape } from './orb-liquid';

export interface OrbLensMaterial {
  halfSize?: { x: number; y: number };
  handleMix?: number;
  mist?: number;
  idleMix?: number;
}

const VERTEX = 'attribute vec2 aPosition; void main(){gl_Position=vec4(aPosition,0.,1.);}';
const FRAGMENT = `
precision highp float;
uniform sampler2D uBg;
uniform vec2 uImageSize, uOffset, uCenter, uDirection, uLocalSize, uHalfSize;
uniform float uScale, uRadius, uMagnification, uRimStrength, uOpacity, uHasImage, uDrawScale, uDeform, uWobble, uDark, uHandleMix, uMist, uIdleMix;
float sq(float x) { return x*x; }
float safeUv(float point, float scale, float size) {
  return clamp(point*scale/size,.5/size,1.-.5/size);
}
vec3 sampleBg(vec2 p) {
  vec2 uv=vec2(safeUv(p.x,uScale,uImageSize.x),safeUv(p.y,uScale,uImageSize.y));
  return texture2D(uBg,uv).rgb;
}
float gaussianWeight(int index) {
  if (index==0 || index==4) return .05449;
  if (index==1 || index==3) return .24420;
  return .40262;
}
vec3 sampleMist(vec2 p) {
  vec3 blurred=vec3(0.);
  for (int y=0; y<5; y++) {
    for (int x=0; x<5; x++) {
      blurred+=sampleBg(p+vec2(float(x-2),float(y-2))*5.)*gaussianWeight(x)*gaussianWeight(y);
    }
  }
  return blurred;
}
vec3 sampleGlass(vec2 p) {
  vec3 base=sampleBg(p);
  if (uMist<=0. || uHasImage<.5) return base;
  return mix(base,sampleMist(p),uMist);
}
float capsuleRadius(float x, float y) {
  float stem=max(0.,uHalfSize.y-uHalfSize.x);
  return sqrt(sq(x)+sq(y-clamp(y,-stem,stem)))/uHalfSize.x;
}
float shape(float theta) {
  vec2 n=vec2(cos(theta),sin(theta));
  vec2 tangent=vec2(-uDirection.y,uDirection.x);
  float stretch=1.+uDeform*.20;
  vec2 q=vec2(dot(n,uDirection)/stretch,dot(n,tangent)*sqrt(stretch));
  float a=atan(q.y,q.x);
  float contour=1.+uDeform*(.045*cos(3.*a)-.035*cos(a))+uWobble*.028*cos(2.*a+.7);
  return contour/length(q);
}
float sourceBend(float r) {
  return 1./uMagnification+.54*pow(clamp(r,0.,1.),7.);
}
float sourcePoint(float point, float offset, float r) {
  return point+offset*(sourceBend(r)-1.);
}
float dispersionWidth(float r) {
  return .52*pow(clamp(r,0.,1.),8.);
}
float glassWhiteMix(float r, float theta) {
  float light=.55+.45*cos(theta+2.25);
  float rimWidth=mix(.012,.55/uHalfSize.x,uHandleMix);
  float rimPosition=mix(.992,1.-.35/uHalfSize.x,uHandleMix);
  float rim=exp(-sq((r-rimPosition)/rimWidth));
  float inner=exp(-sq((r-.943)/.030));
  float caustic=exp(-sq((r-.84)/.095))*(.5+.5*sin(theta-.6));
  return rim*(.28+.5*light)*uRimStrength+inner*.10*light+caustic*.12;
}
float idleSheen(float r, float theta) {
  return uIdleMix*exp(-sq((r-.91)/.065))*pow(max(0.,cos(theta+2.25)),8.)*(.05+.04*uHandleMix);
}
vec3 shadeGlass(vec3 glass, float r, float theta) {
  float light=.55+.45*cos(theta+2.25);
  float shadow=exp(-sq((r-.973)/.018))*(1.-light);
  glass*=1.-shadow*.19*(1.-uIdleMix);
  glass=mix(glass,vec3(.99,.995,1.),glassWhiteMix(r,theta)*(1.-uIdleMix));
  float haze=uIdleMix*uMist*(.045+.035*uDark);
  glass=mix(glass,vec3(.965,.98,1.),haze);
  glass=mix(glass,vec3(1.,1.,1.),idleSheen(r,theta));
  // Tint can exceed white; clamp straight RGB before premultiplying by coverage and opacity.
  return clamp(glass+vec3(.002,.003,.009)*(1.-uDark*.5),0.,1.);
}
vec4 compositeGlass(vec3 glass, float inside, float r, float theta) {
  float lightIdle=uIdleMix*(1.-uDark);
  float glowWidth=mix(mix(.065,.14,uIdleMix),4.5/mix(uRadius,uHalfSize.x,uHandleMix),lightIdle);
  float glowStrength=mix(mix(.055,.10,uIdleMix),.18,lightIdle);
  float glow=exp(-sq((r-1.04)/glowWidth))*glowStrength;
  vec3 glowColor=mix(vec3(.95,.965,1.),vec3(.35,.43,.56),lightIdle);
  float aGlow=glow*(1.-inside)*(1.-inside);
  // Missing safe texture keeps only the idle halo; clear drag retains its transparent edge.
  float surfaceAlpha=inside*mix(clamp(glassWhiteMix(r,theta)+idleSheen(r,theta),0.,1.)*(1.-uIdleMix),1.,uHasImage);
  vec3 surfaceColor=mix(vec3(.99,.995,1.),glass,uHasImage);
  vec3 rgb=(surfaceColor*surfaceAlpha+glowColor*aGlow)*uOpacity;
  float alpha=(surfaceAlpha+aGlow)*uOpacity;
  return vec4(rgb,alpha);
}
void main(){
  vec2 p=vec2(gl_FragCoord.x, uLocalSize.y*uDrawScale-gl_FragCoord.y)/uDrawScale+uOffset;
  vec2 delta=p-uCenter;
  float sphereTheta=length(delta)<.00001?0.:atan(delta.y,delta.x);
  float sphereR=length(delta)/(uRadius*shape(sphereTheta));
  float stem=max(0.,uHalfSize.y-uHalfSize.x);
  vec2 capsuleOffset=vec2(delta.x,delta.y-clamp(delta.y,-stem,stem));
  float r=mix(sphereR,capsuleRadius(delta.x,delta.y),uHandleMix);
  vec2 offset=mix(delta,capsuleOffset,uHandleMix);
  float theta=length(offset)<.00001?0.:atan(offset.y,offset.x);
  float aa=mix(1.1/uRadius,.65/min(uHalfSize.x,uHalfSize.y),uHandleMix);
  float inside=1.-smoothstep(1.-aa,1.+aa,r);
  vec2 source=vec2(sourcePoint(p.x,offset.x,r),sourcePoint(p.y,offset.y,r));
  vec2 ray=normalize(offset+vec2(.001));
  float dispersion=dispersionWidth(r);
  vec3 glass=vec3(0.);
  if (inside>0. && uHasImage>.5) glass=vec3(sampleGlass(source+ray*dispersion).r,sampleGlass(source).g,sampleGlass(source-ray*dispersion).b);
  gl_FragColor=compositeGlass(shadeGlass(glass,r,theta),inside,r,theta);
}`;

/** Owns GPU objects only. Decoded images are closed by the caller after upload. */
export class OrbLens {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly texture: WebGLTexture;
  private readonly shaders: WebGLShader[] = [];
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();
  private imageWidth = 1; private imageHeight = 1; private imageScale = 1;
  private hasImage = false; private disposed = false;

  static create(canvas: HTMLCanvasElement): OrbLens | null {
    try { return new OrbLens(canvas); } catch { return null; }
  }

  private constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const program = gl.createProgram(), buffer = gl.createBuffer(), texture = gl.createTexture();
    if (!program || !buffer || !texture) {
      gl.deleteProgram(program); gl.deleteBuffer(buffer); gl.deleteTexture(texture);
      throw new Error('WebGL allocation failed');
    }
    this.program = program; this.buffer = buffer; this.texture = texture;
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Shader allocation failed');
        this.shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed');
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader link failed');
      gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'aPosition');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, key, gl.LINEAR);
      for (const key of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, key, gl.CLAMP_TO_EDGE);
      // Browser decoded sRGB values stay in the reference shader's sRGB space; no implicit conversion.
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // top-origin image, top-origin UV above
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.clearImage();
    } catch (err) { this.dispose(); throw err; }
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }

  setImage(source: TexImageSource, width: number, height: number, viewportWidth: number): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (gl.getError() !== gl.NO_ERROR) { this.clearImage(); throw new Error('Lens texture upload failed'); }
    this.imageWidth = width; this.imageHeight = height; this.imageScale = width / viewportWidth; this.hasImage = true;
  }

  clearImage(): void {
    if (this.disposed) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,0]));
    this.imageWidth = this.imageHeight = this.imageScale = 1; this.hasImage = false;
  }

  draw(center: { x: number; y: number }, radius: number, liquid: LiquidShape, opacity = 1, dark = false, material: OrbLensMaterial = {}): void {
    if (this.disposed || this.gl.isContextLost()) return;
    const gl = this.gl, size = radius * 3.2, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixels = Math.ceil(size * dpr), drawScale = pixels / size;
    if (this.canvas.width !== pixels || this.canvas.height !== pixels) this.canvas.width = this.canvas.height = pixels;
    Object.assign(this.canvas.style, { left: `${center.x - size/2}px`, top: `${center.y - size/2}px`, width: `${size}px`, height: `${size}px` });
    gl.viewport(0, 0, pixels, pixels); gl.useProgram(this.program);
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(this.uniform('uBg'), 0);
    gl.uniform2f(this.uniform('uImageSize'), this.imageWidth, this.imageHeight);
    gl.uniform2f(this.uniform('uOffset'), center.x-size/2, center.y-size/2);
    // Fragment coordinates use drawScale. Source coordinates use the independently captured imageScale.
    gl.uniform1f(this.uniform('uScale'), this.imageScale);
    gl.uniform2f(this.uniform('uLocalSize'), size, size);
    gl.uniform2f(this.uniform('uCenter'), center.x, center.y);
    gl.uniform1f(this.uniform('uRadius'), radius);
    gl.uniform2f(this.uniform('uDirection'), liquid.dirX, liquid.dirY);
    gl.uniform1f(this.uniform('uDeform'), liquid.deform * .72);
    gl.uniform1f(this.uniform('uWobble'), liquid.wobble);
    gl.uniform1f(this.uniform('uMagnification'), 1.62); gl.uniform1f(this.uniform('uRimStrength'), .64);
    gl.uniform1f(this.uniform('uOpacity'), opacity); gl.uniform1f(this.uniform('uHasImage'), this.hasImage ? 1 : 0);
    gl.uniform1f(this.uniform('uDrawScale'), drawScale);
    gl.uniform1f(this.uniform('uDark'), dark ? 1 : 0);
    gl.uniform2f(this.uniform('uHalfSize'), material.halfSize?.x ?? radius, material.halfSize?.y ?? radius);
    gl.uniform1f(this.uniform('uHandleMix'), material.handleMix ?? 0);
    gl.uniform1f(this.uniform('uMist'), material.mist ?? 0);
    gl.uniform1f(this.uniform('uIdleMix'), material.idleMix ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    gl.deleteTexture(this.texture); gl.deleteBuffer(this.buffer); gl.deleteProgram(this.program);
    for (const shader of this.shaders) gl.deleteShader(shader);
    this.uniforms.clear(); this.canvas.width = this.canvas.height = 1;
  }
}
