// 投影与几何工具。内部统一用"米制平面坐标"(以图幅中心为原点的等距圆柱近似),
// 内河图幅范围小,误差可忽略;存储层仍保留经纬度。
import type { Feature, Geometry } from './types';

export type Vec2 = [number, number];

export class Projection {
  private k: number; // 米/度(纬向)
  private kx: number;
  constructor(private center: Vec2) {
    const lat = (center[1] * Math.PI) / 180;
    this.k = 111320;
    this.kx = this.k * Math.cos(lat);
  }
  toMeters(ll: Vec2): Vec2 {
    return [(ll[0] - this.center[0]) * this.kx, (ll[1] - this.center[1]) * this.k];
  }
  toLonLat(m: Vec2): Vec2 {
    return [m[0] / this.kx + this.center[0], m[1] / this.k + this.center[1]];
  }
}

export type BBox = [number, number, number, number];

export function geomBBox(g: Geometry): BBox {
  const pts: Vec2[] =
    g.kind === 'point' ? [g.xy] : g.kind === 'line' ? g.pts : g.rings.flat();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
export function bboxContains(b: BBox, p: Vec2): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}
export function bboxUnion(a: BBox, b: BBox): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

// ---- 线段求交(用于自交检测) ----
function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 折线/环自交检测:返回相交的线段对下标 */
export function selfIntersections(pts: Vec2[], closed: boolean): [number, number][] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const out: [number, number][] = [];
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 1; j < segs; j++) {
      // 相邻线段(含首尾相邻)不算自交
      if (j === i) continue;
      if (j === i + 1) continue;
      if (closed && i === 0 && j === segs - 1) continue;
      const c = pts[j], d = pts[(j + 1) % n];
      if (segIntersect(a, b, c, d)) out.push([i, j]);
    }
  }
  return out;
}

export function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: Vec2, rings: Vec2[][]): boolean {
  if (!pointInRing(p, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(p, rings[i])) return false;
  return true;
}

/** 点到折线最近距离与沿线参数 */
export function distToPolyline(p: Vec2, pts: Vec2[]): { dist: number; t: number; seg: number } {
  let best = { dist: Infinity, t: 0, seg: 0 };
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    const segLen = Math.sqrt(len2);
    if (d < best.dist) best = { dist: d, t: acc + t * segLen, seg: i };
    acc += segLen;
  }
  return best;
}

export function polylineLength(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** 沿折线取弧长 s 处的点与切向角 */
export function pointAlong(pts: Vec2[], s: number): { p: Vec2; angle: number } {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const L = Math.hypot(bx - ax, by - ay);
    if (acc + L >= s) {
      const t = L === 0 ? 0 : (s - acc) / L;
      return { p: [ax + t * (bx - ax), ay + t * (by - ay)], angle: Math.atan2(by - ay, bx - ax) };
    }
    acc += L;
  }
  const last = pts[pts.length - 1], prev = pts[pts.length - 2] ?? last;
  return { p: last, angle: Math.atan2(last[1] - prev[1], last[0] - prev[0]) };
}

// ---- 耳切三角化(简单多边形,支持无洞;洞在生成端已避免或由调用方保证) ----
export function earcut(ring: Vec2[]): number[] {
  const n = ring.length;
  if (n < 3) return [];
  // 面积符号决定环绕方向
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  const idx = Array.from({ length: n }, (_, i) => i);
  if (area < 0) idx.reverse(); // 统一为逆时针
  const tris: number[] = [];
  let guard = 0;
  const isConvex = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-12;
  const inTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) => {
    const s = (o: Vec2, u: Vec2, v: Vec2) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
    const d1 = s(a, b, p), d2 = s(b, c, p), d3 = s(c, a, p);
    return d1 > 1e-9 && d2 > 1e-9 && d3 > 1e-9; // 边界上的点不阻挡(共线点多时必需)
  };
  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = ring[i0], b = ring[i1], c = ring[i2];
      if (!isConvex(a, b, c)) continue;
      let hasInner = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inTri(ring[j], a, b, c)) { hasInner = true; break; }
      }
      if (hasInner) continue;
      tris.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // 退化多边形,放弃剩余
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

export function featureBBox(f: Feature): BBox { return f.bbox; }
