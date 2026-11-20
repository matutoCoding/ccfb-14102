// 地图视图:画布 + 场景 + 视口 + 交互(平移/缩放/旋转),供各页面复用
import { Scene, type OverlayCtx } from './render/scene';
import { Viewport } from './core/viewport';
import { app } from './app';
import type { Vec2 } from './core/geo';

export class MapView {
  canvas: HTMLCanvasElement;
  scene: Scene;
  vp = new Viewport();
  private raf = 0;
  private destroyed = false;
  private dragging = false;
  private rotating = false;
  private last: Vec2 = [0, 0];
  /** 航向向上时的目标航向(弧度,世界系) */
  heading = 0;
  overlay: ((ctx: OverlayCtx) => void) | null = null;
  onClick: ((world: Vec2, e: MouseEvent) => void) | null = null;
  onDragFeature: ((world: Vec2, kind: 'down' | 'move' | 'up') => boolean) | null = null;
  /** 每帧回调(模拟航行等) */
  onFrame: ((dt: number) => void) | null = null;
  private lastT = 0;
  private clickStart: Vec2 | null = null;

  constructor(private container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    container.appendChild(this.canvas);
    this.scene = new Scene(this.canvas);
    (window as unknown as { __mv: MapView }).__mv = this; // 调试句柄
    this.scene.setPalette(app.palette);
    this.scene.setSettings(app.settings);
    this.scene.setFeatures(app.features);
    this.scene.overlay = ctx => this.overlay?.(ctx);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();

    app.on('settings', () => {
      this.scene.setPalette(app.palette);
      this.scene.setSettings(app.settings);
      this.scene.invalidateColors();
    });
    app.on('features', () => this.scene.setFeatures(app.features));
    app.on('delta', () => {
      const d = app.lastDelta;
      if (d) this.scene.applyDelta(d.adds, d.removes, d.modifies);
    });

    this.canvas.addEventListener('mousedown', e => {
      if (e.button === 2 || e.shiftKey) { this.rotating = true; }
      else if (this.onDragFeature?.(this.toWorld(e), 'down')) { /* 要素拖拽接管 */ }
      else { this.dragging = true; }
      this.last = [e.clientX, e.clientY];
      this.clickStart = [e.clientX, e.clientY];
    });
    window.addEventListener('mousemove', e => {
      if (this.onDragFeature?.(this.toWorld(e), 'move')) { this.last = [e.clientX, e.clientY]; return; }
      const dx = e.clientX - this.last[0], dy = e.clientY - this.last[1];
      if (this.dragging) {
        const c = Math.cos(this.vp.rotation), s = Math.sin(this.vp.rotation);
        this.vp.cx -= (dx * c + dy * s) * this.vp.mpp;
        this.vp.cy -= (-dx * s + dy * c) * this.vp.mpp;
      } else if (this.rotating) {
        this.vp.rotation += dx * 0.008;
      }
      this.last = [e.clientX, e.clientY];
    });
    window.addEventListener('mouseup', e => {
      if (this.onDragFeature?.(this.toWorld(e), 'up')) { this.dragging = this.rotating = false; return; }
      if (this.dragging && this.clickStart) {
        const moved = Math.hypot(e.clientX - this.clickStart[0], e.clientY - this.clickStart[1]);
        if (moved < 4 && this.onClick) this.onClick(this.toWorld(e), e);
      }
      this.dragging = this.rotating = false;
    });
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const px: Vec2 = [e.clientX - rect.left - rect.width / 2, -(e.clientY - rect.top - rect.height / 2)];
      this.vp.zoomAt(px, e.deltaY > 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    const loop = (t: number) => {
      if (this.destroyed) return;
      const dt = Math.min(0.1, (t - this.lastT) / 1000 || 0.016);
      this.lastT = t;
      this.onFrame?.(dt);
      if (app.settings.headingUp) this.vp.rotation = -this.heading;
      this.scene.render(this.vp, t / 1000);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private toWorld(e: MouseEvent): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    const px: Vec2 = [e.clientX - rect.left - rect.width / 2, -(e.clientY - rect.top - rect.height / 2)];
    return this.vp.screenToWorld(px);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.vp.resize(this.canvas.width, this.canvas.height);
  }

  fitExtent(bbox: [number, number, number, number]) {
    this.vp.cx = (bbox[0] + bbox[2]) / 2;
    this.vp.cy = (bbox[1] + bbox[3]) / 2;
    const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
    this.vp.mpp = Math.max(w / this.vp.width, h / this.vp.height) * 1.15;
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.remove();
  }
}
