// 测试图幅生成器:按内河电子航道图要素分类生成一段约 12km 的 synthetic 河段,
// 含岸线、航道边线、水深点、等深线、水深分区、航标、桥梁、锚地、禁航区、河名注记,
// 并故意掺入几何自交、坐标越界、退化多边形等坏要素,供导入校验挑出。
import type { Feature, FeatureClass, Geometry, BuoyProps, LightChar, UpdatePackage } from '../core/types';
import { geomBBox, Projection, type Vec2 } from '../core/geo';

const L = 12000;          // 河段长(米)
const HALF_WATER = 600;   // 水面半宽
const HALF_CHAN = 150;    // 航道半宽

let seq = 0;
function fid(prefix: string) { return `${prefix}-${(seq++).toString(36)}`; }

function centerline(s: number): Vec2 {
  return [s, 800 * Math.sin(s / 1500) + 260 * Math.sin(s / 730)];
}
function tangent(s: number): Vec2 {
  const d = 1;
  const a = centerline(s - d), b = centerline(s + d);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = Math.hypot(dx, dy);
  return [dx / L2, dy / L2];
}
/** 距中心线 off 米(左正右负)的偏移线 */
function offsetLine(off: number, step = 100): Vec2[] {
  const pts: Vec2[] = [];
  for (let s = 0; s <= L; s += step) {
    const [x, y] = centerline(s);
    const [tx, ty] = tangent(s);
    pts.push([x - ty * off, y + tx * off]);
  }
  return pts;
}
/** 两条偏移线围成的带状多边形 */
function ribbon(offA: number, offB: number): Vec2[][] {
  const a = offsetLine(offA), b = offsetLine(offB);
  return [[...a, ...b.reverse()]];
}
/** 水深模型:距中心线越近越深,2~12 米,叠加一点扰动 */
function depthAt(dist: number, s: number): number {
  const base = 12 - Math.pow(Math.min(1, dist / HALF_WATER), 2) * 10;
  const bump = 1.2 * Math.sin(s / 900 + dist / 130) + 0.6 * Math.sin(s / 377);
  return Math.max(0.5, Math.round((base + bump) * 10) / 10);
}

function mk(cls: FeatureClass, geom: Geometry, props: Feature['props']): Feature {
  return { id: fid(cls), cls, geom, props, bbox: geomBBox(geom) };
}

export interface GeneratedChart {
  name: string;
  center: [number, number];
  extent: [number, number, number, number];
  features: Feature[];
}

export function generateTestChart(withBad = true): GeneratedChart {
  seq = 0;
  const feats: Feature[] = [];

  // --- 陆地(两岸之外,用两个大面表示) ---
  const north = offsetLine(HALF_WATER), south = offsetLine(-HALF_WATER);
  const pad = 3000;
  feats.push(mk('coastline', { kind: 'line', pts: north }, { name: '北岸线' }));
  feats.push(mk('coastline', { kind: 'line', pts: south }, { name: '南岸线' }));
  // 陆地面(仅供铺色)
  const northLand: Vec2[] = [...north, [L + pad, north[north.length - 1][1]], [L + pad, 5000], [-pad, 5000], [-pad, north[0][1]]];
  const southLand: Vec2[] = [...south, [L + pad, south[south.length - 1][1]], [L + pad, -5000], [-pad, -5000], [-pad, south[0][1]]];
  feats.push(mk('depthArea', { kind: 'polygon', rings: [northLand] }, { land: true, minDepth: -1, maxDepth: 0 }));
  feats.push(mk('depthArea', { kind: 'polygon', rings: [southLand] }, { land: true, minDepth: -1, maxDepth: 0 }));

  // --- 水深分区(按距中心线距离分带) ---
  const bands: [number, number, number, number][] = [
    // [内缘, 外缘, minDepth, maxDepth]
    [0, 150, 10, 20], [150, 300, 5, 10], [300, 450, 3, 5], [450, 600, 0, 3],
  ];
  for (const [a, b, mn, mx] of bands) {
    feats.push(mk('depthArea', { kind: 'polygon', rings: ribbon(a, b) }, { minDepth: mn, maxDepth: mx }));
    if (a > 0) feats.push(mk('depthArea', { kind: 'polygon', rings: ribbon(-a, -b) }, { minDepth: mn, maxDepth: mx }));
  }

  // --- 等深线 3m / 5m / 10m ---
  for (const [off, dv] of [[450, 3], [300, 5], [150, 10]] as const) {
    feats.push(mk('depthContour', { kind: 'line', pts: offsetLine(off) }, { depthValue: dv }));
    feats.push(mk('depthContour', { kind: 'line', pts: offsetLine(-off) }, { depthValue: dv }));
  }

  // --- 航道边线 ---
  feats.push(mk('channelEdge', { kind: 'line', pts: offsetLine(HALF_CHAN) }, { name: '左航道边线' }));
  feats.push(mk('channelEdge', { kind: 'line', pts: offsetLine(-HALF_CHAN) }, { name: '右航道边线' }));

  // --- 水深点 ---
  const soundings: Feature[] = [];
  for (let s = 300; s < L - 200; s += 260) {
    for (let off = -520; off <= 520; off += 105) {
      const [x, y] = centerline(s);
      const [tx, ty] = tangent(s);
      const px = x - ty * off, py = y + tx * off;
      const d = depthAt(Math.abs(off), s);
      soundings.push(mk('sounding', { kind: 'point', xy: [px, py] }, { depth: d, epoch: 1 }));
    }
  }
  feats.push(...soundings);

  // --- 航标:沿航道边线交替红绿,灯质轮转 ---
  const lightCycle: LightChar[] = [
    { kind: 'Q', period: 1 }, { kind: 'LFl', period: 10 }, { kind: 'Fl', period: 4, count: 1 },
    { kind: 'Mo', code: 'A', period: 12 }, { kind: 'Fl', period: 6, count: 3 }, { kind: 'Iso', period: 4 },
  ];
  let bi = 0;
  for (let s = 600; s < L - 400; s += 750, bi++) {
    for (const side of [1, -1]) {
      const [x, y] = centerline(s + (side < 0 ? 375 : 0));
      const [tx, ty] = tangent(s);
      const px = x - ty * (HALF_CHAN + 25) * side, py = y + tx * (HALF_CHAN + 25) * side;
      const isRed = side > 0; // 左侧标红(下行方向约定,测试数据从简)
      const props: BuoyProps = {
        name: `${isRed ? '红' : '绿'}浮${Math.floor(bi) + 1}号`,
        shape: isRed ? 'can' : 'cone',
        color: isRed ? 'red' : 'green',
        light: lightCycle[(bi + (side > 0 ? 0 : 3)) % lightCycle.length],
        lightColor: isRed ? 'red' : 'green',
        status: 'normal',
        topmark: isRed ? 'can' : 'cone',
      };
      feats.push(mk('buoy', { kind: 'point', xy: [px, py] }, { name: props.name, buoy: props, priority: 8 }));
    }
  }
  // 两座状态异常标:一座移位、一座漂失
  const ab1 = feats.find(f => f.cls === 'buoy');
  if (ab1?.props.buoy) ab1.props.buoy.status = 'shifted';
  const ab2 = feats.filter(f => f.cls === 'buoy')[5];
  if (ab2?.props.buoy) ab2.props.buoy.status = 'drifted';
  // 桥区侧面标(黄色专用标)
  {
    const [x, y] = centerline(6000);
    const bp: BuoyProps = { name: '桥涵标', shape: 'pillar', color: 'yellow', light: { kind: 'VQ', period: 0.5 }, lightColor: 'yellow', status: 'normal', topmark: 'cross' };
    feats.push(mk('buoy', { kind: 'point', xy: [x, y + 120] }, { name: bp.name, buoy: bp, priority: 9 }));
  }

  // --- 桥梁 ---
  {
    const [x, y] = centerline(6000);
    const [tx, ty] = tangent(6000);
    const nx = -ty, ny = tx;
    const w = 40; // 桥宽
    const pts: Vec2[] = [];
    for (const d of [-HALF_WATER - 200, HALF_WATER + 200]) pts.push([x + nx * d, y + ny * d]);
    const deck: Vec2[] = [
      [pts[0][0] - tx * w, pts[0][1] - ty * w], [pts[1][0] - tx * w, pts[1][1] - ty * w],
      [pts[1][0] + tx * w, pts[1][1] + ty * w], [pts[0][0] + tx * w, pts[0][1] + ty * w],
    ];
    feats.push(mk('bridge', { kind: 'polygon', rings: [deck] }, { name: '测试长江大桥', priority: 9 }));
  }

  // --- 锚地 ---
  {
    const c = centerline(9200), t = tangent(9200);
    const off = (d: number, s: number): Vec2 => {
      const p = centerline(s);
      return [p[0] - t[1] * d, p[1] + t[0] * d];
    };
    const ring = [off(320, 8800), off(560, 8800), off(560, 9600), off(320, 9600)];
    feats.push(mk('anchorage', { kind: 'polygon', rings: [ring] }, { name: '测试锚地', priority: 6 }));
    void c;
  }

  // --- 禁航区 ---
  {
    const t = tangent(3000);
    const off = (d: number, s: number): Vec2 => {
      const p = centerline(s);
      return [p[0] - t[1] * d, p[1] + t[0] * d];
    };
    const ring = [off(-200, 2700), off(200, 2700), off(200, 3300), off(-200, 3300)];
    feats.push(mk('restrictedArea', { kind: 'polygon', rings: [ring] }, { name: '施工禁航区', priority: 7 }));
  }

  // --- 河名注记(沿中心线排布) ---
  const clPts: Vec2[] = [];
  for (let s = 1500; s <= 10500; s += 60) clPts.push(centerline(s));
  feats.push(mk('riverName', { kind: 'line', pts: clPts }, { name: '长 江', priority: 3 }));

  // --- 坏要素(导入校验应挑出) ---
  if (withBad) {
    // 1) 自交多边形(领结形)
    const bowtie: Vec2[] = [[1000, 3000], [1600, 3600], [1600, 3000], [1000, 3600]];
    feats.push(mk('depthArea', { kind: 'polygon', rings: [bowtie] }, { minDepth: 0, maxDepth: 2, _bad: 'self-intersect' }));
    // 2) 坐标越界水深点(跑到图幅范围外几十万米)
    feats.push(mk('sounding', { kind: 'point', xy: [L + 500000, 800000] }, { depth: 9.9, epoch: 1, _bad: 'out-of-bounds' }));
    // 3) 自交岸线
    const zag: Vec2[] = [[2000, 4200], [2600, 4200], [2100, 4600], [2500, 3900], [2000, 4200]];
    feats.push(mk('coastline', { kind: 'line', pts: zag }, { name: '异常岸线', _bad: 'self-intersect' }));
    // 4) 退化多边形(不足 3 点)
    feats.push(mk('restrictedArea', { kind: 'polygon', rings: [[[500, 500], [800, 500]]] }, { name: '退化禁航区', _bad: 'degenerate' }));
  }

  // 图幅范围(米)→ 经纬度
  const center: [number, number] = [114.30, 30.55];
  const proj = new Projection(center);
  const c0 = proj.toLonLat([-pad, -5000]);
  const c1 = proj.toLonLat([L + pad, 5000]);
  return { name: '测试图幅 CJ-001(12km 河段)', center, extent: [c0[0], c0[1], c1[0], c1[1]], features: feats };
}

// ---- 导入校验:挑出坏要素 ----
export interface ValidationIssue { featureId: string; cls: FeatureClass; problem: string }
import { selfIntersections } from '../core/geo';

export function validateFeatures(feats: Feature[], extentM: [number, number, number, number]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const [x0, y0, x1, y1] = extentM;
  const margin = 20000; // 允许图幅外一定余量
  for (const f of feats) {
    if (f.geom.kind === 'polygon') {
      for (const ring of f.geom.rings) {
        if (ring.length < 3) {
          issues.push({ featureId: f.id, cls: f.cls, problem: `退化多边形:环仅 ${ring.length} 个点` });
          break;
        }
        const hits = selfIntersections(ring, true);
        if (hits.length) {
          issues.push({ featureId: f.id, cls: f.cls, problem: `多边形自交:${hits.length} 处(段 ${hits[0][0]}×${hits[0][1]})` });
          break;
        }
      }
    } else if (f.geom.kind === 'line') {
      const hits = selfIntersections(f.geom.pts, false);
      if (hits.length) issues.push({ featureId: f.id, cls: f.cls, problem: `线要素自交:${hits.length} 处` });
    }
    const b = f.bbox;
    if (b[0] < x0 - margin || b[2] > x1 + margin || b[1] < y0 - margin || b[3] > y1 + margin) {
      issues.push({ featureId: f.id, cls: f.cls, problem: `坐标越界:bbox 超出图幅范围 ${margin / 1000}km 余量` });
    }
  }
  return issues;
}

// ---- 测试用增量更新包:某区域新测水深(含冲淤变化)+ 航标调整 ----
export function generateTestUpdate(allFeatures: Feature[]): UpdatePackage {
  const region: [number, number, number, number] = [4200, -1500, 7200, 1500];
  const adds: Feature[] = [];
  // 新测深点:区域内加密,一半淤积(水深浅了 0.5~1.5m),一小片冲刷(深了 1~2m)
  for (let s = 4300; s <= 7100; s += 130) {
    for (let off = -500; off <= 500; off += 90) {
      const [x, y] = centerline(s);
      const [tx, ty] = tangent(s);
      const px = x - ty * off, py = y + tx * off;
      let d = depthAt(Math.abs(off), s);
      if (s < 5800) d = Math.max(0.4, d - (0.5 + 1.0 * Math.abs(Math.sin(s / 300 + off / 200)))); // 淤积
      else d = d + 1.0 + 0.8 * Math.abs(Math.sin(s / 260)); // 冲刷
      adds.push(mk('sounding', { kind: 'point', xy: [px, py] }, { depth: Math.round(d * 10) / 10, epoch: 2 }));
    }
  }
  // 新等深线(3m 线向河心推移)
  const newContour = offsetLine(380).filter((_, i) => {
    const s = i * 100;
    return s >= 4200 && s <= 7200;
  });
  adds.push(mk('depthContour', { kind: 'line', pts: newContour }, { depthValue: 3, epoch: 2 }));
  // 一座航标移位更新 + 删除一座
  const buoys = allFeatures.filter(f => f.cls === 'buoy');
  const moved = buoys[8];
  const modifies: Feature[] = [];
  if (moved && moved.geom.kind === 'point') {
    const [x, y] = moved.geom.xy;
    modifies.push({ ...moved, geom: { kind: 'point', xy: [x + 60, y - 40] }, props: { ...moved.props } });
  }
  const removes = buoys[10] ? [buoys[10].id] : [];
  return {
    id: `upd-${Date.now().toString(36)}`,
    name: '2026-11 航道扫测更新包(4.2km~7.2km)',
    date: Date.now(),
    epoch: 2,
    region,
    adds, removes, modifies,
  };
}
