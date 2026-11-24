import field from '../../../flutter/feedback/shaders/water_field.glsl?raw';
import type { RegionViewport } from './region';
import type { WakePoint } from './wake-gestures';

const vertex = `attribute vec2 position;
varying vec2 uv;
void main() {
  uv = vec2(position.x, -position.y) * .5 + .5;
  gl_Position = vec4(position, 0., 1.);
}`;
const fragment = `precision highp float;
varying vec2 uv;
uniform sampler2D frozen;
uniform vec2 size;
uniform vec2 origin;
uniform float seconds;
uniform float radius;
vec4 readWater(vec2 coord) { return texture2D(frozen, coord); }
${field}
void main() { gl_FragColor = waterSurface(uv * size, size, origin, radius, seconds); }`;

export function createWaterSurface(image: HTMLImageElement, size: RegionViewport, origin: WakePoint) {
  const canvas = document.createElement('canvas');
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(size.width * ratio));
  canvas.height = Math.max(1, Math.round(size.height * ratio));
  const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const program = gl.createProgram(), buffer = gl.createBuffer(), texture = gl.createTexture();
  function dispose() {
    gl!.deleteTexture(texture);
    gl!.deleteBuffer(buffer);
    gl!.deleteProgram(program);
    gl!.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
  }
  try {
    if (!program || !buffer || !texture) throw new Error('Water surface allocation failed');
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Shader allocation failed');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader); // released with the program
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Water surface shader unavailable');
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, key, gl.LINEAR);
    for (const key of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, key, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Frozen image upload failed');
    gl.uniform2f(gl.getUniformLocation(program, 'size'), size.width, size.height);
    gl.uniform2f(gl.getUniformLocation(program, 'origin'), origin.x, origin.y);
    const time = gl.getUniformLocation(program, 'seconds');
    const radius = gl.getUniformLocation(program, 'radius');
    gl.viewport(0, 0, canvas.width, canvas.height);
    return { canvas, dispose, draw(seconds: number, crestRadius: number) {
      if (gl.isContextLost()) return false;
      gl.uniform1f(time, seconds);
      gl.uniform1f(radius, crestRadius);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    } };
  } catch {
    dispose();
    return null;
  }
}
