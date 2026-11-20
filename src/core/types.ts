// 要素模型:按内河电子航道图要素分类
export type FeatureClass =
  | 'depthArea'    // 水深分区(等深带)
  | 'depthContour' // 等深线
  | 'sounding'     // 水深点
  | 'coastline'    // 岸线
  | 'channelEdge'  // 航道边线
  | 'buoy'         // 航标
  | 'bridge'       // 桥梁
  | 'anchorage'    // 锚地
  | 'restrictedArea' // 禁航区
  | 'riverName';   // 河流注记(沿河道中心线)

export type Geometry =
  | { kind: 'point'; xy: [number, number] }
  | { kind: 'line'; pts: [number, number][] }
  | { kind: 'polygon'; rings: [number, number][][] }; // 首环外环,其余为洞

export type BuoyShape = 'can' | 'cone' | 'sphere' | 'pillar' | 'spar' | 'lightvessel';
export type BuoyColor = 'red' | 'green' | 'yellow' | 'white' | 'black' | 'redWhite' | 'blackYellow';
export type BuoyStatus = 'normal' | 'shifted' | 'drifted'; // 正常 / 移位 / 漂失

// 灯质:快闪 Q、长闪 LFl、莫尔斯 Mo(X)、单闪 Fl、联闪 Fl(n)
export type LightChar =
  | { kind: 'Q'; period: number }                    // 快闪,周期 1s
  | { kind: 'VQ'; period: number }                   // 甚快闪 0.5s
  | { kind: 'LFl'; period: number }                  // 长闪(亮2s)
  | { kind: 'Fl'; period: number; count: number }    // 单闪/联闪
  | { kind: 'Mo'; code: string; period: number }     // 莫尔斯码,如 'A'
  | { kind: 'Iso'; period: number }                  // 等明暗
  | { kind: 'Oc'; period: number };                  // 互光(暗短亮长)

export interface BuoyProps {
  name: string;
  shape: BuoyShape;
  color: BuoyColor;
  light: LightChar | null;
  lightColor: 'white' | 'red' | 'green' | 'yellow';
  status: BuoyStatus;
  topmark?: 'can' | 'cone' | 'sphere' | 'cross' | 'none';
}

export interface Feature {
  id: string;
  cls: FeatureClass;
  geom: Geometry;
  props: Record<string, unknown> & {
    name?: string;
    depth?: number;        // sounding: 水深值(米)
    minDepth?: number;     // depthArea
    maxDepth?: number;     // depthArea
    depthValue?: number;   // depthContour
    buoy?: BuoyProps;
    priority?: number;     // 注记优先级,大者先排
    epoch?: number;        // 所属水深期次
  };
  bbox: [number, number, number, number];
}

export interface ChartMeta {
  id: string;
  name: string;
  createdAt: number;
  center: [number, number]; // 投影中心(经纬度)
  extent: [number, number, number, number]; // 经纬度范围
  featureCount: number;
}

export interface UpdatePackage {
  id: string;
  name: string;
  date: number;
  epoch: number;                 // 水深期次号
  region: [number, number, number, number]; // 影响范围(米制 bbox)
  adds: Feature[];
  removes: string[];             // feature id
  modifies: Feature[];
}

export interface DepthEpoch {
  epoch: number;
  date: number;
  label: string;
}

export interface Settings {
  palette: 'day' | 'dusk' | 'night';
  draft: number;          // 本船吃水(米)
  safetyMargin: number;   // 富余水深(米)
  showSoundings: boolean;
  showLabels: boolean;
  headingUp: boolean;
  simSpeedKn: number;
}

export const DEFAULT_SETTINGS: Settings = {
  palette: 'day',
  draft: 2.5,
  safetyMargin: 0.5,
  showSoundings: true,
  showLabels: true,
  headingUp: false,
  simSpeedKn: 8,
};

// 比例尺分档:米/像素阈值 → 细节级别
export const SCALE_BANDS = [
  { name: '1:2千',  maxMpp: 1 },
  { name: '1:5千',  maxMpp: 3 },
  { name: '1:2万',  maxMpp: 10 },
  { name: '1:5万',  maxMpp: 25 },
  { name: '1:20万', maxMpp: Infinity },
] as const;
