// 增量更新包管理 + 两期水深差值(冲淤)计算
import type { Feature, UpdatePackage } from './types';
import type { Vec2 } from './geo';
import { bboxIntersects, type BBox } from './geo';

/** 应用增量包到要素集,返回受影响要素类与范围 */
export function applyPackage(features: Feature[], pkg: UpdatePackage): { features: Feature[]; affectedClasses: string[] } {
  const rm = new Set(pkg.removes);
  const affected = new Set<string>();
  let out = features.filter(f => {
    if (rm.has(f.id)) { affected.add(f.cls); return false; }
    return true;
  });
  const byId = new Map(out.map(f => [f.id, f]));
  for (const m of pkg.modifies) {
    if (byId.has(m.id)) { affected.add(m.cls); byId.set(m.id, m); }
  }
  out = [...byId.values(), ...pkg.adds];
  for (const a of pkg.adds) affected.add(a.cls);
  return { features: out, affectedClasses: [...affected] };
}

/** 区域更新查询:找出影响范围与查询矩形相交的更新包 */
export function updatesInRegion(updates: UpdatePackage[], region: BBox): UpdatePackage[] {
  return updates.filter(u => bboxIntersects(u.region, region)).sort((a, b) => b.date - a.date);
}

// ---- 两期水深差值网格(IDW 插值) ----
export interface DiffGrid {
  x0: number; y0: number; cell: number;
  cols: number; rows: number;
  values: Float32Array; // B - A(正=冲刷加深,负=淤积变浅),NaN=无数据
  maxAbs: number;
}

function idwGrid(soundings: { p: Vec2; d: number }[], x0: number, y0: number, cell: number, cols: number, rows: number, radius: number): Float32Array {
  const out = new Float32Array(cols * rows).fill(NaN);
  // 简单空间哈希加速
  const buckets = new Map<string, number[]>();
  const bk = (x: number, y: number) => `${Math.floor(x / radius)},${Math.floor(y / radius)}`;
  soundings.forEach((s, i) => {
    const k = bk(s.p[0], s.p[1]);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
  });
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + (c + 0.5) * cell, y = y0 + (r + 0.5) * cell;
      let wsum = 0, vsum = 0;
      const bc = Math.floor(x / radius), br = Math.floor(y / radius);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const arr = buckets.get(`${bc + dc},${br + dr}`);
        if (!arr) continue;
        for (const i of arr) {
          const s = soundings[i];
          const d2 = (s.p[0] - x) ** 2 + (s.p[1] - y) ** 2;
          if (d2 > radius * radius) continue;
          const w = 1 / Math.max(d2, 1);
          wsum += w; vsum += w * s.d;
        }
      }
      if (wsum > 0) out[r * cols + c] = vsum / wsum;
    }
  }
  return out;
}

export function computeDepthDiff(
  epochA: Feature[], epochB: Feature[],
  region: BBox, cell = 60,
): DiffGrid {
  const pick = (feats: Feature[]) =>
    feats.filter(f => f.cls === 'sounding' && f.geom.kind === 'point')
      .map(f => ({ p: (f.geom as { xy: Vec2 }).xy, d: f.props.depth ?? 0 }));
  const [x0, y0, x1, y1] = region;
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell));
  const rows = Math.max(1, Math.ceil((y1 - y0) / cell));
  const radius = cell * 4;
  const ga = idwGrid(pick(epochA), x0, y0, cell, cols, rows, radius);
  const gb = idwGrid(pick(epochB), x0, y0, cell, cols, rows, radius);
  const values = new Float32Array(cols * rows).fill(NaN);
  let maxAbs = 0.3;
  for (let i = 0; i < values.length; i++) {
    if (Number.isNaN(ga[i]) || Number.isNaN(gb[i])) continue;
    values[i] = gb[i] - ga[i];
    maxAbs = Math.max(maxAbs, Math.abs(values[i]));
  }
  return { x0, y0, cell, cols, rows, values, maxAbs };
}

/** 差值网格 → 色斑图 canvas(红=冲刷加深,蓝=淤积变浅) */
export function diffToCanvas(diff: DiffGrid, erosionColor: string, siltColor: string): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = diff.cols; cv.height = diff.rows;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(diff.cols, diff.rows);
  const parse = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const er = parse(erosionColor), si = parse(siltColor);
  for (let r = 0; r < diff.rows; r++) {
    for (let c = 0; c < diff.cols; c++) {
      const v = diff.values[r * diff.cols + c];
      const o = ((diff.rows - 1 - r) * diff.cols + c) * 4; // canvas y 向下
      if (Number.isNaN(v) || Math.abs(v) < 0.15) { img.data[o + 3] = 0; continue; }
      const t = Math.min(1, Math.abs(v) / diff.maxAbs);
      const col = v > 0 ? er : si;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2];
      img.data[o + 3] = Math.round(40 + 140 * t);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
