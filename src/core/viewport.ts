// 视口:中心(米)、比例(米/像素)、旋转(弧度,正北向上=0,航向向上=航向角)
export class Viewport {
  cx = 0; cy = 0;
  mpp = 5;          // meters per pixel
  rotation = 0;     // 视图旋转角(世界→屏幕)
  width = 1; height = 1;

  resize(w: number, h: number) { this.width = w; this.height = h; }

  /** 世界(米)→屏幕(像素,原点在画布中心,y 向上) */
  worldToScreen(p: [number, number]): [number, number] {
    const dx = p[0] - this.cx, dy = p[1] - this.cy;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return [(dx * c - dy * s) / this.mpp, (dx * s + dy * c) / this.mpp];
  }
  screenToWorld(px: [number, number]): [number, number] {
    const x = px[0] * this.mpp, y = px[1] * this.mpp;
    const c = Math.cos(this.rotation), s = Math.sin(this.rotation);
    return [this.cx + x * c + y * s, this.cy - x * s + y * c];
  }
  zoomAt(screenPx: [number, number], factor: number) {
    const before = this.screenToWorld(screenPx);
    this.mpp = Math.min(80, Math.max(0.4, this.mpp * factor));
    const after = this.screenToWorld(screenPx);
    this.cx += before[0] - after[0];
    this.cy += before[1] - after[1];
  }
  /** 可见世界范围 bbox(带旋转,取外包) */
  visibleBBox(): [number, number, number, number] {
    const corners: [number, number][] = [
      this.screenToWorld([-this.width / 2, -this.height / 2]),
      this.screenToWorld([this.width / 2, -this.height / 2]),
      this.screenToWorld([this.width / 2, this.height / 2]),
      this.screenToWorld([-this.width / 2, this.height / 2]),
    ];
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  scaleBand(): number {
    // 与 SCALE_BANDS 对应的档
    if (this.mpp <= 1) return 0;
    if (this.mpp <= 3) return 1;
    if (this.mpp <= 10) return 2;
    if (this.mpp <= 25) return 3;
    return 4;
  }
}
