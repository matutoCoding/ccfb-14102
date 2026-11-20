// WebGL2 基础:着色器编译、程序封装
export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh)}\n${src}`);
  }
  return sh;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

// 公共顶点变换:世界(米)→裁剪坐标;像素偏移在投影后叠加,保证屏幕等宽/等大
export const VIEW_UNIFORMS = `
uniform vec2 u_center;
uniform float u_mpp;
uniform float u_rotation;
uniform vec2 u_resolution;
vec2 worldToClip(vec2 w) {
  vec2 d = w - u_center;
  float c = cos(u_rotation), s = sin(u_rotation);
  vec2 px = vec2(d.x * c - d.y * s, d.x * s + d.y * c) / u_mpp;
  return vec2(px.x * 2.0 / u_resolution.x, px.y * 2.0 / u_resolution.y);
}
vec2 pxToClip(vec2 px) { return vec2(px.x * 2.0 / u_resolution.x, px.y * 2.0 / u_resolution.y); }
`;

export class Program {
  prog: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  constructor(public gl: WebGL2RenderingContext, vs: string, fs: string) {
    this.prog = createProgram(gl, vs, fs);
  }
  use() { this.gl.useProgram(this.prog); }
  u(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.uniforms.get(name)!;
  }
  setView(center: [number, number], mpp: number, rotation: number, w: number, h: number) {
    const gl = this.gl;
    gl.uniform2f(this.u('u_center'), center[0], center[1]);
    gl.uniform1f(this.u('u_mpp'), mpp);
    gl.uniform1f(this.u('u_rotation'), rotation);
    gl.uniform2f(this.u('u_resolution'), w, h);
  }
}

export function makeVAO(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const v = gl.createVertexArray();
  if (!v) throw new Error('no vao');
  return v;
}

export class Buffer {
  buf: WebGLBuffer;
  constructor(public gl: WebGL2RenderingContext, public target: number) {
    this.buf = gl.createBuffer()!;
  }
  upload(data: Float32Array | Uint16Array | Uint32Array, usage = this.gl.STATIC_DRAW) {
    this.gl.bindBuffer(this.target, this.buf);
    this.gl.bufferData(this.target, data, usage);
  }
}
