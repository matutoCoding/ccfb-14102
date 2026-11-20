// 白天 / 黄昏 / 夜间三套调色板。夜间整体压亮度,但红绿侧标保持可区分。
export type PaletteName = 'day' | 'dusk' | 'night';

export interface Palette {
  water: string;        // 深水(安全)水域
  shallow: string;      // 浅于安全等深线水域
  veryShallow: string;  // 浅于吃水的水域(更醒目)
  land: string;
  landEdge: string;
  channelEdge: string;
  contour: string;
  safetyContour: string;
  soundingSafe: string;
  soundingUnsafe: string;
  buoyRed: string;
  buoyGreen: string;
  buoyYellow: string;
  buoyWhite: string;
  buoyBlack: string;
  structure: string;    // 桥梁等构造物
  anchorage: string;
  restricted: string;
  restrictedFill: string;
  label: string;
  labelHalo: string;
  ownship: string;
  route: string;
  alarm: string;
  cluster: string;
  erosion: string;      // 冲刷
  siltation: string;    // 淤积
}

function hex(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
}
/** 整体压暗(夜间用),factor<1 */
function dim(c: string, f: number): string {
  const [r, g, b] = hex(c);
  const q = (v: number) => Math.round(Math.min(1, v * f) * 255).toString(16).padStart(2, '0');
  return `#${q(r)}${q(g)}${q(b)}`;
}

const DAY: Palette = {
  water: '#aad3df', shallow: '#d6ecf2', veryShallow: '#eef7fa',
  land: '#e8ddc0', landEdge: '#7a6f52',
  channelEdge: '#c04df0', contour: '#6b9dc4', safetyContour: '#1a5caa',
  soundingSafe: '#3a6f9e', soundingUnsafe: '#c0392b',
  buoyRed: '#d43a2f', buoyGreen: '#1e8a4c', buoyYellow: '#e0b400', buoyWhite: '#f5f5f5', buoyBlack: '#222',
  structure: '#5a5148', anchorage: '#8a5fb0', restricted: '#c0392b', restrictedFill: '#c0392b',
  label: '#1c3a52', labelHalo: '#f4f8fa',
  ownship: '#0a3d91', route: '#0a6e0a', alarm: '#ff2d2d', cluster: '#2255aa',
  erosion: '#d4553a', siltation: '#3a6fd4',
};

const DUSK: Palette = {
  ...DAY,
  water: dim('#aad3df', 0.62), shallow: dim('#d6ecf2', 0.62), veryShallow: dim('#eef7fa', 0.62),
  land: dim('#e8ddc0', 0.55), landEdge: dim('#7a6f52', 0.8),
  label: '#d8cba8', labelHalo: '#2a2620',
  soundingSafe: '#9fb6c9', soundingUnsafe: '#e0705c',
};

// 夜间:背景大幅压暗,航标红绿保持高饱和以便区分
const NIGHT: Palette = {
  ...DUSK,
  water: '#0d2431', shallow: '#12303f', veryShallow: '#17394a',
  land: '#241f16', landEdge: '#4a4136',
  channelEdge: '#a03cc8', contour: '#3a5a74', safetyContour: '#4f9be0',
  soundingSafe: '#7f9db5', soundingUnsafe: '#ff6b57',
  buoyRed: '#ff4a3d', buoyGreen: '#2ee06a', buoyYellow: '#ffd23a', buoyWhite: '#e8e8e8', buoyBlack: '#0a0a0a',
  structure: '#6a6156', anchorage: '#a07fd0', restricted: '#ff5040', restrictedFill: '#802018',
  label: '#d0c8b0', labelHalo: '#101418',
  ownship: '#4f9bff', route: '#3ad04a', alarm: '#ff4040', cluster: '#6f9fe0',
  erosion: '#e06a50', siltation: '#5a8fe0',
};

export const PALETTES: Record<PaletteName, Palette> = { day: DAY, dusk: DUSK, night: NIGHT };

export function cssToRgb(c: string): [number, number, number] { return hex(c); }
export function cssToRgba(c: string, a = 1): [number, number, number, number] { const [r, g, b] = hex(c); return [r, g, b, a]; }
