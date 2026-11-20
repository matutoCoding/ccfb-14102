// 航标灯质:按真实闪光节奏计算某一时刻灯是否点亮。
// 周期单位:秒。快闪 Q=60次/分(周期1s),甚快闪 VQ=120次/分,
// 长闪 LFl 亮 2s,莫尔斯按 短0.5s/长1.5s/间隔0.5s 编排。
import type { LightChar } from './types';

const DOT = 0.5, DASH = 1.5, GAP = 0.5, LETTER_GAP = 1.5;

const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....',
};

/** 生成一个周期内"亮灯区间"列表 [[start,end],...],周期总长按灯质标准 */
export function lightIntervals(lc: LightChar): { period: number; on: [number, number][] } {
  switch (lc.kind) {
    case 'Q':  return { period: 1, on: [[0, 0.3]] };            // 快闪:每分钟60次
    case 'VQ': return { period: 0.5, on: [[0, 0.15]] };         // 甚快闪
    case 'LFl': return { period: lc.period, on: [[0, 2]] };     // 长闪:亮2s
    case 'Iso': return { period: lc.period, on: [[0, lc.period / 2]] };
    case 'Oc': return { period: lc.period, on: [[0, lc.period * 0.7]] }; // 亮长暗短
    case 'Fl': {
      // 联闪 Fl(count):组内短闪,组间长暗
      const on: [number, number][] = [];
      for (let i = 0; i < lc.count; i++) on.push([i * (DOT + GAP), i * (DOT + GAP) + DOT]);
      return { period: lc.period, on };
    }
    case 'Mo': {
      const seq = MORSE[lc.code.toUpperCase()] ?? '.-';
      const on: [number, number][] = [];
      let t = 0;
      for (const ch of seq) {
        const dur = ch === '.' ? DOT : DASH;
        on.push([t, t + dur]);
        t += dur + GAP;
      }
      t += LETTER_GAP;
      return { period: Math.max(lc.period, t), on };
    }
  }
}

export function isLit(lc: LightChar, timeSec: number): boolean {
  const { period, on } = lightIntervals(lc);
  const t = ((timeSec % period) + period) % period;
  return on.some(([a, b]) => t >= a && t < b);
}

export function lightLabel(lc: LightChar | null): string {
  if (!lc) return '无灯';
  switch (lc.kind) {
    case 'Q': return '快闪';
    case 'VQ': return '甚快闪';
    case 'LFl': return `长闪${lc.period}s`;
    case 'Fl': return lc.count > 1 ? `联闪(${lc.count})${lc.period}s` : `单闪${lc.period}s`;
    case 'Mo': return `莫尔斯${lc.code}${lc.period}s`;
    case 'Iso': return `等明暗${lc.period}s`;
    case 'Oc': return `互光${lc.period}s`;
  }
}
