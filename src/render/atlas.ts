// 图集:把矢量符号定义和文字渲染到 canvas,打包成一张纹理。
// 符号按"矢量定义"逐类绘制(罐形/锥形/球形/柱形/灯船、顶标、灯焰),
// 调色板切换时重建图集;文字带晕边,逐字缓存,支持沿河曲线逐字旋转排布。
import type { Palette } from '../core/palette';
import type { BuoyProps } from '../core/types';

export interface Sprite { x: number; y: number; w: number; h: number; ax: number; ay: number } // ax,ay: 锚点(相对左上,像素)

const ATLAS_SIZE = 2048;

export class Atlas {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cursorX = 0; private cursorY = 0; private rowH = 0;
  private textCache = new Map<string, Sprite>();
  private symbolCache = new Map<string, Sprite>();
  texture: WebGLTexture | null = null;
  dirty = true;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = ATLAS_SIZE;
    this.ctx = this.canvas.getContext('2d')!;
  }

  private alloc(w: number, h: number): [number, number] {
    if (this.cursorX + w > ATLAS_SIZE) { this.cursorX = 0; this.cursorY += this.rowH; this.rowH = 0; }
    if (this.cursorY + h > ATLAS_SIZE) throw new Error('atlas full');
    const pos: [number, number] = [this.cursorX, this.cursorY];
    this.cursorX += w + 1;
    this.rowH = Math.max(this.rowH, h + 1);
    return pos;
  }

  /** 文字精灵(带晕边)。size 为像素字号。 */
  textSprite(text: string, size: number, color: string, halo: string, bold = false): Sprite {
    const key = `t|${text}|${size}|${color}|${halo}|${bold}`;
    const hit = this.textCache.get(key);
    if (hit) return hit;
    const ctx = this.ctx;
    const font = `${bold ? '700' : '400'} ${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const h = size + 8;
    const [x, y] = this.alloc(w, h);
    ctx.save();
    ctx.translate(x + 4, y + 4);
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.lineWidth = Math.max(2, size / 6);
    ctx.strokeStyle = halo;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
    const sp: Sprite = { x, y, w, h, ax: w / 2, ay: h / 2 };
    this.textCache.set(key, sp);
    this.dirty = true;
    return sp;
  }

  /** 航标矢量符号。size 为符号主体高度(像素)。 */
  buoySprite(bp: BuoyProps, pal: Palette, lit: boolean, size = 26): Sprite {
    const key = `b|${bp.shape}|${bp.color}|${bp.topmark}|${bp.status}|${lit ? bp.lightColor : 'x'}|${pal.water}`;
    const hit = this.symbolCache.get(key);
    if (hit) return hit;
    const S = size;
    const W = S + 16, H = S + 26; // 顶部留顶标位,底部留浮筒
    const [x, y] = this.alloc(W, H);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x + W / 2, y + H - 6); // 锚点:符号正下方(浮筒中心)
    const bodyColor =
      bp.color === 'red' ? pal.buoyRed : bp.color === 'green' ? pal.buoyGreen :
      bp.color === 'yellow' ? pal.buoyYellow : bp.color === 'white' ? pal.buoyWhite : pal.buoyBlack;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = pal.buoyBlack === bodyColor ? '#888' : '#222';
    ctx.fillStyle = bodyColor;
    const hs = S / 2;
    ctx.beginPath();
    switch (bp.shape) {
      case 'can': ctx.rect(-hs * 0.62, -S, hs * 1.24, S); break;
      case 'cone': ctx.moveTo(0, -S); ctx.lineTo(hs * 0.7, 0); ctx.lineTo(-hs * 0.7, 0); ctx.closePath(); break;
      case 'sphere': ctx.arc(0, -hs, hs * 0.72, 0, Math.PI * 2); break;
      case 'spar': ctx.moveTo(0, -S * 1.1); ctx.lineTo(hs * 0.28, 0); ctx.lineTo(-hs * 0.28, 0); ctx.closePath(); break;
      case 'lightvessel': ctx.moveTo(-hs, -hs * 0.6); ctx.lineTo(hs, -hs * 0.6); ctx.lineTo(hs * 0.6, 0); ctx.lineTo(-hs * 0.6, 0); ctx.closePath(); break;
      case 'pillar': default: ctx.rect(-hs * 0.4, -S, hs * 0.8, S); break;
    }
    ctx.fill(); ctx.stroke();
    // 顶标
    if (bp.topmark && bp.topmark !== 'none') {
      ctx.beginPath();
      const ty = -S - 5;
      switch (bp.topmark) {
        case 'can': ctx.rect(-3.5, ty - 7, 7, 7); break;
        case 'cone': ctx.moveTo(0, ty - 8); ctx.lineTo(4, ty); ctx.lineTo(-4, ty); ctx.closePath(); break;
        case 'sphere': ctx.arc(0, ty - 4, 4, 0, Math.PI * 2); break;
        case 'cross':
          ctx.moveTo(-4, ty - 4); ctx.lineTo(4, ty - 4); ctx.moveTo(0, ty - 8); ctx.lineTo(0, ty);
          ctx.stroke(); ctx.beginPath(); break;
      }
      if (bp.topmark !== 'cross') { ctx.fill(); ctx.stroke(); }
    }
    // 灯焰(点亮时画光芒圆)
    if (lit) {
      const lc = bp.lightColor === 'red' ? pal.buoyRed : bp.lightColor === 'green' ? pal.buoyGreen :
        bp.lightColor === 'yellow' ? pal.buoyYellow : '#fff8d0';
      const g = ctx.createRadialGradient(0, -S - 2, 1, 0, -S - 2, 12);
      g.addColorStop(0, lc);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, -S - 2, 12, 0, Math.PI * 2); ctx.fill();
    }
    // 状态标记:移位=橙色圆圈,漂失=红色叉
    if (bp.status !== 'normal') {
      ctx.lineWidth = 2.2;
      if (bp.status === 'shifted') {
        ctx.strokeStyle = '#ff8c00';
        ctx.beginPath(); ctx.arc(0, -hs, hs + 6, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeStyle = '#ff2020';
        const r = hs + 6;
        ctx.beginPath();
        ctx.moveTo(-r, -hs - r); ctx.lineTo(r, -hs + r);
        ctx.moveTo(r, -hs - r); ctx.lineTo(-r, -hs + r);
        ctx.stroke();
      }
    }
    ctx.restore();
    const sp: Sprite = { x, y, w: W, h: H, ax: W / 2, ay: H - 6 };
    this.symbolCache.set(key, sp);
    this.dirty = true;
    return sp;
  }

  /** 通用圆形符号(航标簇、本船等) */
  discSprite(key: string, draw: (ctx: CanvasRenderingContext2D, s: number) => void, size: number): Sprite {
    const k = `d|${key}`;
    const hit = this.symbolCache.get(k);
    if (hit) return hit;
    const [x, y] = this.alloc(size, size);
    this.ctx.save();
    this.ctx.translate(x + size / 2, y + size / 2);
    draw(this.ctx, size);
    this.ctx.restore();
    const sp: Sprite = { x, y, w: size, h: size, ax: size / 2, ay: size / 2 };
    this.symbolCache.set(k, sp);
    this.dirty = true;
    return sp;
  }

  clearSymbols() { this.symbolCache.clear(); }

  upload(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.texture) {
      this.texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if (this.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
      this.dirty = false;
    }
    return this.texture;
  }
}
