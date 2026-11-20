// 场景渲染器:要素分批(按类)静态 VAO + 每帧动态精灵(符号/文字)。
// 增量更新只重建受影响类的 batch;吃水/调色板变化只重建颜色相关 batch。
import { Program, VIEW_UNIFORMS, makeVAO } from './gl';
import { Atlas, type Sprite } from './atlas';
import type { Palette } from '../core/palette';
import { cssToRgba } from '../core/palette';
import type { Feature, Settings, BuoyProps } from '../core/types';
import { Viewport } from '../core/viewport';
import { earcut, pointAlong, polylineLength, type Vec2 } from '../core/geo';
import { isLit } from '../core/lights';

// ---------- 着色器 ----------
const AREA_VS = `#version 300 es
precision highp float;
in vec2 a_pos; in vec4 a_color; in float a_pattern;
out vec4 v_color; out float v_pattern;
${VIEW_UNIFORMS}
void main() { v_color = a_color; v_pattern = a_pattern; gl_Position = vec4(worldToClip(a_pos), 0.0, 1.0); }`;

const AREA_FS = `#version 300 es
precision highp float;
in vec4 v_color; in float v_pattern;
out vec4 outColor;
void main() {
  vec4 c = v_color;
  if (v_pattern > 0.5 && v_pattern < 1.5) {          // 斜线 hatch(屏幕锚定)
    float m = mod(gl_FragCoord.x + gl_FragCoord.y, 9.0);
    if (m > 1.6) discard;
  } else if (v_pattern >= 1.5) {                      // 点阵
    vec2 g = mod(gl_FragCoord.xy, 14.0) - 7.0;
    if (dot(g, g) > 2.6) discard;
  }
  outColor = c;
}`;

const LINE_VS = `#version 300 es
precision highp float;
in vec2 a_pos; in vec2 a_miter; in float a_side; in float a_dist;
in vec4 a_color; in vec3 a_style; // widthPx, dashPx, gapPx
out vec4 v_color; out float v_distPx; out vec2 v_dash;
${VIEW_UNIFORMS}
void main() {
  float c = cos(u_rotation), s = sin(u_rotation);
  vec2 dir = vec2(a_miter.x * c - a_miter.y * s, a_miter.x * s + a_miter.y * c);
  vec2 clip = worldToClip(a_pos);
  clip += pxToClip(dir * a_side * a_style.x * 0.5);
  v_color = a_color; v_distPx = a_dist / u_mpp; v_dash = a_style.yz;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec4 v_color; in float v_distPx; in vec2 v_dash;
out vec4 outColor;
void main() {
  if (v_dash.x > 0.0) {
    float m = mod(v_distPx, v_dash.x + v_dash.y);
    if (m > v_dash.x) discard;
  }
  outColor = v_color;
}`;

const SPRITE_VS = `#version 300 es
precision highp float;
in vec2 a_corner;                 // (-0.5..0.5)
in vec2 i_pos; in vec2 i_size; in float i_angle;
in vec4 i_uv; in vec4 i_color; in float i_mode;
uniform vec2 u_atlas;
out vec2 v_uv; out vec4 v_color;
${VIEW_UNIFORMS}
void main() {
  float ang = 0.0;
  if (i_mode > 0.5) {
    ang = i_angle + u_rotation;                 // 世界方向 → 屏幕方向
    if (i_mode < 1.5 && cos(ang) < 0.0) ang += 3.14159265; // 保持文字朝上
  }
  float c = cos(ang), s = sin(ang);
  vec2 px = a_corner * i_size;
  px = vec2(px.x * c - px.y * s, px.x * s + px.y * c);
  vec2 clip = worldToClip(i_pos) + pxToClip(px);
  v_uv = (i_uv.xy + (a_corner + 0.5) * i_uv.zw) / u_atlas;
  v_color = i_color;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_color;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  vec4 t = texture(u_tex, v_uv);
  outColor = vec4(t.rgb * v_color.rgb, t.a * v_color.a);
  if (outColor.a < 0.01) discard;
}`;

// ---------- batch 数据结构 ----------
interface Batch { vao: WebGLVertexArrayObject; buf: WebGLBuffer; count: number }

export interface OverlayLine { pts: Vec2[]; color: string; width: number; dash?: [number, number] }
export interface OverlaySprite { pos: Vec2; sprite: Sprite; size?: [number, number]; angle?: number; mode?: number }
export interface OverlayCtx {
  line(l: OverlayLine): void;
  sprite(s: OverlaySprite): void;
}

const CLS_BUILD_ORDER: string[] = [
  'depthArea', 'restrictedArea', 'anchorage', 'bridge',
  'depthContour', 'coastline', 'channelEdge',
];

export class Scene {
  private gl: WebGL2RenderingContext;
  private areaProg: Program; private lineProg: Program; private spriteProg: Program;
  atlas = new Atlas();
  features: Feature[] = [];
  private byClass = new Map<string, Feature[]>();
  private areaBatches = new Map<string, Batch>();
  private lineBatches = new Map<string, Batch>();
  private dirtyClasses = new Set<string>();
  private quadVAO: WebGLVertexArrayObject;
  private quadBuf: WebGLBuffer; // 保留 JS 引用,防止 GC 回收 GL 缓冲
  private instBuf: WebGLBuffer;
  private dynLineVAO: WebGLVertexArrayObject;
  private dynLineBuf: WebGLBuffer;
  private spriteCount = 0;
  private dynLineCount = 0;
  palette!: Palette;
  settings!: Settings;
  lastRebuildInfo = '';
  overlay: ((ctx: OverlayCtx) => void) | null = null;
  private overlayLines: OverlayLine[] = [];
  private overlaySprites: OverlaySprite[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('需要 WebGL2 支持');
    this.gl = gl;
    this.areaProg = new Program(gl, AREA_VS, AREA_FS);
    this.lineProg = new Program(gl, LINE_VS, LINE_FS);
    this.spriteProg = new Program(gl, SPRITE_VS, SPRITE_FS);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // 精灵四边形(实例化)
    this.quadVAO = makeVAO(gl);
    gl.bindVertexArray(this.quadVAO);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    this.attr(this.spriteProg, 'a_corner', 2, 2, 0, 0);
    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const stride = 14 * 4;
    let off = 0;
    for (const [name, size] of [['i_pos', 2], ['i_size', 2], ['i_angle', 1], ['i_uv', 4], ['i_color', 4], ['i_mode', 1]] as const) {
      this.attr(this.spriteProg, name, size, stride, off, 1);
      off += size * 4;
    }
    gl.bindVertexArray(null);

    this.dynLineVAO = makeVAO(gl);
    gl.bindVertexArray(this.dynLineVAO);
    this.dynLineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynLineBuf);
    this.lineAttribs(this.lineProg);
    gl.bindVertexArray(null);
  }

  private attr(prog: Program, name: string, size: number, stride: number, offset: number, divisor = 0) {
    const gl = this.gl;
    const loc = gl.getAttribLocation(prog.prog, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    if (divisor) gl.vertexAttribDivisor(loc, divisor);
  }

  private lineAttribs(prog: Program) {
    const stride = 13 * 4;
    let off = 0;
    for (const [name, size] of [['a_pos', 2], ['a_miter', 2], ['a_side', 1], ['a_dist', 1], ['a_color', 4], ['a_style', 3]] as const) {
      this.attr(prog, name, size, stride, off);
      off += size * 4;
    }
  }

  // ---------- 数据装载 ----------
  private reindex() {
    this.byClass.clear();
    for (const f of this.features) {
      const arr = this.byClass.get(f.cls) ?? [];
      arr.push(f);
      this.byClass.set(f.cls, arr);
    }
  }

  setFeatures(feats: Feature[]) {
    this.features = feats;
    this.reindex();
    for (const c of CLS_BUILD_ORDER) this.dirtyClasses.add(c);
  }

  /** 增量更新:只把受影响类标脏,其余 batch 原样保留(不整图重建) */
  applyDelta(adds: Feature[], removes: string[], modifies: Feature[]) {
    const rm = new Set(removes);
    const affected = new Set<string>();
    this.features = this.features.filter(f => {
      if (rm.has(f.id)) { affected.add(f.cls); return false; }
      return true;
    });
    for (const m of modifies) {
      const i = this.features.findIndex(f => f.id === m.id);
      if (i >= 0) { affected.add(this.features[i].cls); this.features[i] = m; }
    }
    for (const a of adds) { this.features.push(a); affected.add(a.cls); }
    this.reindex();
    for (const c of affected) if (CLS_BUILD_ORDER.includes(c)) this.dirtyClasses.add(c);
    const staticHit = [...affected].filter(c => CLS_BUILD_ORDER.includes(c));
    this.lastRebuildInfo = staticHit.length
      ? `增量重建:${staticHit.join('、')} 类,其余静态图层未动`
      : '增量重建:仅动态要素(水深点/航标),静态图层未动';
  }

  /** 吃水/调色板变化:只重建颜色相关 batch */
  invalidateColors() {
    this.dirtyClasses.add('depthArea');
    this.dirtyClasses.add('depthContour');
    this.atlas.clearSymbols();
  }

  setPalette(p: Palette) { this.palette = p; this.invalidateColors(); }
  setSettings(s: Settings) { this.settings = s; }

  // ---------- 静态 batch 构建 ----------
  private rebuildDirty() {
    if (!this.dirtyClasses.size) return;
    for (const cls of this.dirtyClasses) {
      if (cls === 'sounding' || cls === 'buoy' || cls === 'riverName') continue;
      const feats = this.byClass.get(cls) ?? [];
      const areaData: number[] = [];
      const lineData: number[] = [];
      for (const f of feats) this.buildFeature(f, areaData, lineData);
      if (areaData.length) this.areaBatches.set(cls, this.makeBatch(areaData, 'area'));
      else this.areaBatches.delete(cls);
      if (lineData.length) this.lineBatches.set(cls, this.makeBatch(lineData, 'line'));
      else this.lineBatches.delete(cls);
    }
    this.dirtyClasses.clear();
  }

  private makeBatch(data: number[], kind: 'area' | 'line'): Batch {
    const gl = this.gl;
    const vao = makeVAO(gl);
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const arr = new Float32Array(data);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    if (kind === 'area') {
      const stride = 7 * 4;
      this.attr(this.areaProg, 'a_pos', 2, stride, 0);
      this.attr(this.areaProg, 'a_color', 4, stride, 8);
      this.attr(this.areaProg, 'a_pattern', 1, stride, 24);
    } else {
      this.lineAttribs(this.lineProg);
    }
    gl.bindVertexArray(null);
    return { vao, buf, count: kind === 'area' ? arr.length / 7 : arr.length / 13 };
  }

  private pushArea(out: number[], ring: Vec2[], color: string, alpha: number, pattern: number) {
    const [r, g, b, a0] = cssToRgba(color, alpha);
    const tris = earcut(ring);
    for (const t of tris) {
      const [x, y] = ring[t];
      out.push(x, y, r, g, b, a0, pattern);
    }
  }

  private pushLine(out: number[], pts: Vec2[], color: string, alpha: number, widthPx: number, dash = 0, gap = 0, closed = false) {
    if (pts.length < 2) return;
    const [r, g, b, a] = cssToRgba(color, alpha);
    const n = pts.length;
    // 计算每点 miter 法线(世界系单位向量)
    const segDir: Vec2[] = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      const L = Math.hypot(dx, dy) || 1;
      segDir.push([dx / L, dy / L]);
    }
    const miterAt = (i: number): Vec2 => {
      const d0 = segDir[Math.max(0, i - 1)], d1 = segDir[Math.min(segDir.length - 1, i)];
      let nx = -(d0[1] + d1[1]), ny = d0[0] + d1[0];
      const L = Math.hypot(nx, ny);
      if (L < 1e-6) return [-d1[1], d1[0]];
      nx /= L; ny /= L;
      // miter 长度补偿,限制最大 2.5 倍
      const dot = nx * -d1[1] + ny * d1[0];
      const scale = Math.min(2.5, 1 / Math.max(0.4, Math.abs(dot)));
      return [nx * scale, ny * scale];
    };
    let dist = 0;
    const v = (i: number, side: number) => {
      const m = miterAt(i);
      out.push(pts[i][0], pts[i][1], m[0], m[1], side, dist, r, g, b, a, widthPx, dash, gap);
    };
    const count = closed ? n : n; // 闭合线由调用方重复首点
    for (let i = 0; i < count - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1];
      const segLen = Math.hypot(dx, dy);
      const d0 = dist;
      // 两个三角形:(i,-)(i,+)(i+1,-) 和 (i,+)(i+1,+)(i+1,-)
      v(i, -1); v(i, 1); dist = d0 + segLen; v(i + 1, -1);
      dist = d0; v(i, 1); dist = d0 + segLen; v(i + 1, 1); v(i + 1, -1);
      dist = d0 + segLen;
    }
  }

  private buildFeature(f: Feature, area: number[], line: number[]) {
    const p = this.palette;
    const safety = this.settings.draft + this.settings.safetyMargin;
    switch (f.cls) {
      case 'depthArea': {
        if (f.geom.kind !== 'polygon') return;
        let color: string;
        if (f.props.land) color = p.land;
        else {
          const mn = f.props.minDepth ?? 99, mx = f.props.maxDepth ?? 99;
          color = mx < this.settings.draft ? p.veryShallow : mn < safety ? p.shallow : p.water;
        }
        this.pushArea(area, f.geom.rings[0], color, 1, 0);
        break;
      }
      case 'restrictedArea': {
        if (f.geom.kind !== 'polygon') return;
        this.pushArea(area, f.geom.rings[0], p.restrictedFill, 0.5, 1);
        this.pushLine(line, [...f.geom.rings[0], f.geom.rings[0][0]], p.restricted, 0.9, 2, 8, 5);
        break;
      }
      case 'anchorage': {
        if (f.geom.kind !== 'polygon') return;
        this.pushArea(area, f.geom.rings[0], p.anchorage, 0.14, 0);
        this.pushLine(line, [...f.geom.rings[0], f.geom.rings[0][0]], p.anchorage, 0.9, 2, 10, 6);
        break;
      }
      case 'bridge': {
        if (f.geom.kind !== 'polygon') return;
        this.pushArea(area, f.geom.rings[0], p.structure, 1, 0);
        this.pushLine(line, [...f.geom.rings[0], f.geom.rings[0][0]], p.structure, 1, 2.5);
        break;
      }
      case 'coastline':
        if (f.geom.kind === 'line') this.pushLine(line, f.geom.pts, p.landEdge, 1, 2.5);
        break;
      case 'channelEdge': {
        if (f.geom.kind !== 'line') return;
        // 复合线:紫色虚线 + 垂直短刻度(刻度长度随比例换算,构建时按当前 mpp 近似)
        this.pushLine(line, f.geom.pts, p.channelEdge, 0.95, 2, 12, 7);
        const L = polylineLength(f.geom.pts);
        const tickLen = 7 * this.mppApprox();
        for (let s = 45; s < L; s += 90 * this.mppApprox()) {
          const { p: pt, angle } = pointAlong(f.geom.pts, s);
          const nx = -Math.sin(angle), ny = Math.cos(angle);
          this.pushLine(line, [[pt[0], pt[1]], [pt[0] + nx * tickLen, pt[1] + ny * tickLen]], p.channelEdge, 0.95, 1.5);
        }
        break;
      }
      case 'depthContour': {
        if (f.geom.kind !== 'line') return;
        const dv = f.props.depthValue ?? 0;
        const isSafety = Math.abs(dv - this.safetyContourValue()) < 1e-6;
        this.pushLine(line, f.geom.pts, isSafety ? p.safetyContour : p.contour, 1, isSafety ? 3.5 : 1.2);
        break;
      }
    }
  }

  private mppCache = 5;
  private mppApprox() { return this.mppCache; }

  /** 安全等深线值:不小于安全水深的最浅一根等深线 */
  safetyContourValue(): number {
    const safety = this.settings.draft + this.settings.safetyMargin;
    const vals = (this.byClass.get('depthContour') ?? [])
      .map(f => f.props.depthValue ?? 0).filter(v => v > 0);
    const uniq = [...new Set(vals)].sort((a, b) => a - b);
    return uniq.find(v => v >= safety) ?? uniq[uniq.length - 1] ?? safety;
  }

  // ---------- 帧渲染 ----------
  render(vp: Viewport, timeSec: number) {
    const gl = this.gl;
    this.mppCache = vp.mpp;
    this.rebuildDirty();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    // 覆盖范围外按陆地/无数据底色处理
    const bg = cssToRgba(this.palette.land, 1);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const setView = (p: Program) => p.setView([vp.cx, vp.cy], vp.mpp, vp.rotation, this.canvas.width, this.canvas.height);

    // 1) 面
    this.areaProg.use(); setView(this.areaProg);
    for (const cls of CLS_BUILD_ORDER) {
      const b = this.areaBatches.get(cls);
      if (b) { gl.bindVertexArray(b.vao); gl.drawArrays(gl.TRIANGLES, 0, b.count); }
    }
    // 2) 线
    this.lineProg.use(); setView(this.lineProg);
    for (const cls of CLS_BUILD_ORDER) {
      const b = this.lineBatches.get(cls);
      if (b) { gl.bindVertexArray(b.vao); gl.drawArrays(gl.TRIANGLES, 0, b.count); }
    }
    // 3) 覆盖层动态线(航线/测量线)
    this.overlayLines = [];
    this.overlaySprites = [];
    this.overlay?.({ line: l => this.overlayLines.push(l), sprite: s => this.overlaySprites.push(s) });
    if (this.overlayLines.length) {
      const data: number[] = [];
      for (const l of this.overlayLines) this.pushLine(data, l.pts, l.color, 1, l.width, l.dash?.[0] ?? 0, l.dash?.[1] ?? 0);
      const arr = new Float32Array(data);
      gl.bindVertexArray(this.dynLineVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dynLineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      this.dynLineCount = arr.length / 13;
      gl.drawArrays(gl.TRIANGLES, 0, this.dynLineCount);
    }

    // 4) 动态精灵:水深点 / 航标 / 注记 / 覆盖层符号
    const inst = this.buildSprites(vp, timeSec);
    this.spriteProg.use(); setView(this.spriteProg);
    this.gl.uniform2f(this.spriteProg.u('u_atlas'), 2048, 2048);
    this.gl.activeTexture(gl.TEXTURE0);
    this.gl.bindTexture(gl.TEXTURE_2D, this.atlas.upload(gl));
    this.gl.uniform1i(this.spriteProg.u('u_tex'), 0);
    gl.bindVertexArray(this.quadVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
    this.spriteCount = inst.length / 14;
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.spriteCount);
    gl.bindVertexArray(null);
  }

  // ---------- 每帧精灵构建(抽稀/聚合/避让/灯质) ----------
  private inst: number[] = [];
  private pushSprite(pos: Vec2, sp: Sprite, size: [number, number], angle: number, mode: number, tint: [number, number, number, number] = [1, 1, 1, 1]) {
    this.inst.push(pos[0], pos[1], size[0], size[1], angle, sp.x, sp.y, sp.w, sp.h, tint[0], tint[1], tint[2], tint[3], mode);
  }

  private buildSprites(vp: Viewport, timeSec: number): Float32Array {
    this.inst = [];
    const pal = this.palette;
    const safety = this.settings.draft + this.settings.safetyMargin;
    const band = vp.scaleBand();
    const vis = vp.visibleBBox();
    const inView = (p: Vec2, m = 200) => p[0] > vis[0] - m && p[0] < vis[2] + m && p[1] > vis[1] - m && p[1] < vis[3] + m;

    // --- 水深点:按档抽稀,浅点优先保留 ---
    if (this.settings.showSoundings && band < 4) {
      const spacing = [26, 30, 38, 52][band] ?? 52;
      const snd = (this.byClass.get('sounding') ?? []).filter(f => f.geom.kind === 'point' && inView((f.geom as { xy: Vec2 }).xy));
      snd.sort((a, b) => (a.props.depth ?? 99) - (b.props.depth ?? 99));
      const grid = new Map<string, boolean>();
      for (const f of snd) {
        const xy = (f.geom as { xy: Vec2 }).xy;
        const [sx, sy] = vp.worldToScreen(xy);
        const key = `${Math.floor(sx / spacing)},${Math.floor(sy / spacing)}`;
        if (grid.has(key)) continue;
        grid.set(key, true);
        const d = f.props.depth ?? 0;
        const safe = d >= safety;
        const color = safe ? pal.soundingSafe : pal.soundingUnsafe;
        const txt = d.toFixed(1);
        const sp = this.atlas.textSprite(txt, 12, color, pal.labelHalo);
        this.pushSprite(xy, sp, [sp.w, sp.h], 0, 0);
      }
    }

    // --- 航标:低档逐个画,高档聚合 ---
    const buoys = (this.byClass.get('buoy') ?? []).filter(f => f.geom.kind === 'point' && inView((f.geom as { xy: Vec2 }).xy, 400));
    const clusterMode = band >= 3;
    const labelCandidates: { pos: Vec2; sp: Sprite; priority: number; anchor: Vec2 }[] = [];
    if (clusterMode) {
      const cell = 56;
      const clusters = new Map<string, Feature[]>();
      for (const f of buoys) {
        const xy = (f.geom as { xy: Vec2 }).xy;
        const [sx, sy] = vp.worldToScreen(xy);
        const key = `${Math.floor(sx / cell)},${Math.floor(sy / cell)}`;
        (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(f);
      }
      for (const members of clusters.values()) {
        if (members.length === 1) this.drawBuoy(members[0], timeSec, labelCandidates);
        else {
          let cx = 0, cy = 0;
          for (const m of members) { const xy = (m.geom as { xy: Vec2 }).xy; cx += xy[0]; cy += xy[1]; }
          cx /= members.length; cy /= members.length;
          const sp = this.atlas.discSprite(`cluster${pal.water}`, (ctx, s) => {
            ctx.beginPath(); ctx.arc(0, 0, s / 2 - 2, 0, Math.PI * 2);
            ctx.fillStyle = pal.cluster; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
          }, 30);
          this.pushSprite([cx, cy], sp, [30, 30], 0, 0);
          const nsp = this.atlas.textSprite(String(members.length), 13, '#ffffff', 'rgba(0,0,0,0.6)', true);
          this.pushSprite([cx, cy], nsp, [nsp.w, nsp.h], 0, 0);
        }
      }
    } else {
      for (const f of buoys) this.drawBuoy(f, timeSec, labelCandidates);
    }

    // --- 其它注记候选:桥/锚地/禁航区 ---
    if (this.settings.showLabels) {
      for (const cls of ['bridge', 'anchorage', 'restrictedArea'] as const) {
        for (const f of this.byClass.get(cls) ?? []) {
          const name = f.props.name;
          if (!name) continue;
          const cx = (f.bbox[0] + f.bbox[2]) / 2, cy = (f.bbox[1] + f.bbox[3]) / 2;
          if (!inView([cx, cy], 600)) continue;
          const sp = this.atlas.textSprite(name, 13, pal.label, pal.labelHalo);
          labelCandidates.push({ pos: [cx, cy], sp, priority: f.props.priority ?? 5, anchor: [cx, cy] });
        }
      }
      // 锚地加锚符号
      for (const f of this.byClass.get('anchorage') ?? []) {
        const cx = (f.bbox[0] + f.bbox[2]) / 2, cy = (f.bbox[1] + f.bbox[3]) / 2;
        const sp = this.atlas.textSprite('⚓', 22, pal.anchorage, pal.labelHalo, true);
        this.pushSprite([cx, cy], sp, [sp.w, sp.h], 0, 0);
      }
    }

    // --- 注记避让:优先级排序,候选位碰撞检测 ---
    if (this.settings.showLabels) {
      labelCandidates.sort((a, b) => b.priority - a.priority);
      const placed: [number, number, number, number][] = [];
      const offsets: [number, number][] = [[14, 0], [-14, 0], [0, 16], [0, -16], [14, 14], [-14, -14]];
      for (const c of labelCandidates) {
        const [ax, ay] = vp.worldToScreen(c.anchor);
        let ok = false;
        for (const [ox, oy] of offsets) {
          const w = c.sp.w, h = c.sp.h;
          const x0 = ax + ox - w / 2 - (ox < 0 ? w / 2 : ox > 0 ? -w / 2 : 0);
          const box: [number, number, number, number] = [x0, ay + oy - h / 2, x0 + w, ay + oy + h / 2];
          if (placed.some(b2 => !(box[2] < b2[0] || box[0] > b2[2] || box[3] < b2[1] || box[1] > b2[3]))) continue;
          placed.push(box);
          // 屏幕像素偏移 → 世界坐标锚点不变,直接用偏移后的屏幕点反算
          const wp = vp.screenToWorld([box[0] + w / 2, box[1] + h / 2]);
          this.pushSprite(wp, c.sp, [c.sp.w, c.sp.h], 0, 0);
          ok = true;
          break;
        }
        void ok; // 放不下就隐藏(按优先级已保证重要的先放)
      }
    }

    // --- 河名:沿中心线逐字弯曲排布,随图旋转保持朝上 ---
    if (this.settings.showLabels && band < 4) {
      for (const f of this.byClass.get('riverName') ?? []) {
        if (f.geom.kind !== 'line' || !f.props.name) continue;
        const text = f.props.name.replace(/\s/g, '');
        const size = 26;
        const total = polylineLength(f.geom.pts);
        const spacing = total / (text.length + 1);
        for (let i = 0; i < text.length; i++) {
          const { p, angle } = pointAlong(f.geom.pts, spacing * (i + 0.5));
          if (!inView(p, 300)) continue;
          const sp = this.atlas.textSprite(text[i], size, pal.label, pal.labelHalo, true);
          this.pushSprite(p, sp, [sp.w, sp.h], angle, 1); // mode1: 随线弯曲且保持朝上
        }
      }
    }

    // --- 覆盖层符号 ---
    for (const s of this.overlaySprites) {
      this.pushSprite(s.pos, s.sprite, s.size ?? [s.sprite.w, s.sprite.h], s.angle ?? 0, s.mode ?? 0);
    }

    return new Float32Array(this.inst);
  }

  private drawBuoy(f: Feature, timeSec: number, labels: { pos: Vec2; sp: Sprite; priority: number; anchor: Vec2 }[]) {
    const bp = f.props.buoy as BuoyProps | undefined;
    if (!bp || f.geom.kind !== 'point') return;
    const lit = bp.light ? isLit(bp.light, timeSec) : false;
    const sp = this.atlas.buoySprite(bp, this.palette, lit);
    this.pushSprite(f.geom.xy, sp, [sp.w, sp.h], 0, 0);
    if (this.settings.showLabels && bp.name) {
      const tsp = this.atlas.textSprite(bp.name, 12, this.palette.label, this.palette.labelHalo);
      labels.push({ pos: f.geom.xy, sp: tsp, priority: f.props.priority ?? 8, anchor: f.geom.xy });
    }
  }
}
