// 航道图显示:主图 + 测量 + 计划航线模拟 + 航向/正北向上 + 偏航报警
import { app } from '../app';
import { MapView } from '../mapview';
import { SCALE_BANDS } from '../core/types';
import { distToPolyline, polylineLength, pointAlong, type Vec2 } from '../core/geo';

function bearing(a: Vec2, b: Vec2): number {
  return (90 - (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 360;
}
const fmtD = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);

export function renderMapPage(root: HTMLElement) {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="row">
      <h2>航道图显示</h2>
      <label>吃水 <input id="draft" type="number" step="0.1" min="0.5" max="8" style="width:64px"> m</label>
      <label>富余 <input id="margin" type="number" step="0.1" min="0" max="3" style="width:56px"> m</label>
      <span id="safetyLabel" class="badge warn"></span>
      <span class="muted">滚轮缩放 · 拖拽平移 · Shift/右键拖拽旋转</span>
    </div>
    <div class="map-wrap grow">
      <div class="hud" id="hud"></div>
      <div class="toolbar">
        <button id="pal">切换:白天</button>
        <button id="orient">正北向上</button>
        <button id="measure">量距离方位</button>
        <button id="route">规划航线</button>
        <button id="sim" disabled>开始模拟</button>
        <button id="clear">清除标绘</button>
      </div>
      <div class="alarm" id="alarm" hidden>⚠ 偏出航道边线</div>
    </div>`;
  root.appendChild(page);

  const wrap = page.querySelector<HTMLElement>('.map-wrap')!;
  const mv = new MapView(wrap);
  const hud = page.querySelector<HTMLElement>('#hud')!;
  const alarmEl = page.querySelector<HTMLElement>('#alarm')!;

  // 初始视野:图幅范围
  const fit = () => {
    if (!app.features.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of app.features) {
      if (Math.abs(f.bbox[0]) > 1e6) continue; // 越界坏要素不参与取景
      x0 = Math.min(x0, f.bbox[0]); y0 = Math.min(y0, f.bbox[1]);
      x1 = Math.max(x1, f.bbox[2]); y1 = Math.max(y1, f.bbox[3]);
    }
    if (x0 < Infinity) mv.fitExtent([x0, y0, x1, y1]);
  };
  fit();
  app.on('features', fit);

  // --- 吃水/富余 → 安全水深实时重算 ---
  const draftInput = page.querySelector<HTMLInputElement>('#draft')!;
  const marginInput = page.querySelector<HTMLInputElement>('#margin')!;
  const safetyLabel = page.querySelector<HTMLElement>('#safetyLabel')!;
  draftInput.value = String(app.settings.draft);
  marginInput.value = String(app.settings.safetyMargin);
  const applySafety = async () => {
    await app.updateSetting({ draft: +draftInput.value || 0, safetyMargin: +marginInput.value || 0 });
    safetyLabel.textContent = `安全水深 ${(app.settings.draft + app.settings.safetyMargin).toFixed(1)} m · 安全等深线 ${mv.scene.safetyContourValue()} m`;
  };
  draftInput.onchange = applySafety;
  marginInput.onchange = applySafety;
  safetyLabel.textContent = `安全水深 ${(app.settings.draft + app.settings.safetyMargin).toFixed(1)} m`;

  // --- 调色板一键切换 ---
  const palBtn = page.querySelector<HTMLButtonElement>('#pal')!;
  const palNames = { day: '白天', dusk: '黄昏', night: '夜间' } as const;
  const palOrder = ['day', 'dusk', 'night'] as const;
  const syncPal = () => { palBtn.textContent = `切换:${palNames[app.settings.palette]}`; };
  syncPal();
  palBtn.onclick = async () => {
    const i = palOrder.indexOf(app.settings.palette);
    await app.updateSetting({ palette: palOrder[(i + 1) % 3] });
    syncPal();
  };

  // --- 航向向上 / 正北向上 ---
  const orientBtn = page.querySelector<HTMLButtonElement>('#orient')!;
  orientBtn.onclick = async () => {
    await app.updateSetting({ headingUp: !app.settings.headingUp });
    orientBtn.textContent = app.settings.headingUp ? '航向向上' : '正北向上';
    if (!app.settings.headingUp) mv.vp.rotation = 0;
  };

  // --- 测量 / 航线状态 ---
  let mode: 'pan' | 'measure' | 'route' = 'pan';
  let measurePts: Vec2[] = [];
  let routePts: Vec2[] = [];
  let simOn = false;
  let shipS = 0;
  let shipPos: Vec2 | null = null;
  let shipHeading = 0;

  const measureBtn = page.querySelector<HTMLButtonElement>('#measure')!;
  const routeBtn = page.querySelector<HTMLButtonElement>('#route')!;
  const simBtn = page.querySelector<HTMLButtonElement>('#sim')!;
  const setMode = (m: typeof mode) => {
    mode = m;
    measureBtn.classList.toggle('primary', m === 'measure');
    routeBtn.classList.toggle('primary', m === 'route');
  };
  measureBtn.onclick = () => { setMode(mode === 'measure' ? 'pan' : 'measure'); };
  routeBtn.onclick = () => { setMode(mode === 'route' ? 'pan' : 'route'); };
  simBtn.onclick = () => {
    simOn = !simOn;
    simBtn.textContent = simOn ? '停止模拟' : '开始模拟';
    if (simOn && routePts.length >= 2) shipS = 0;
  };
  page.querySelector('#clear')!.addEventListener('click', () => {
    measurePts = []; routePts = []; simOn = false; shipPos = null;
    simBtn.disabled = true; simBtn.textContent = '开始模拟';
    setMode('pan');
  });

  mv.onClick = w => {
    if (mode === 'measure') measurePts.push(w);
    else if (mode === 'route') {
      routePts.push(w);
      simBtn.disabled = routePts.length < 2;
    }
  };

  // 航道边线(偏航判定用)
  const channelEdges = () => app.features.filter(f => f.cls === 'channelEdge' && f.geom.kind === 'line')
    .map(f => (f.geom as { pts: Vec2[] }).pts);

  mv.onFrame = dt => {
    if (simOn && routePts.length >= 2) {
      const speed = app.settings.simSpeedKn * 0.5144; // 节 → m/s
      shipS += speed * dt;
      const total = polylineLength(routePts);
      if (shipS >= total) { shipS = total; simOn = false; simBtn.textContent = '开始模拟'; }
      const { p, angle } = pointAlong(routePts, shipS);
      shipPos = p;
      shipHeading = angle;
      mv.heading = angle;
      if (app.settings.headingUp) { mv.vp.cx = p[0]; mv.vp.cy = p[1]; }
      // 偏航判定:到两侧航道边线距离之和明显大于航道宽 → 偏出
      const edges = channelEdges();
      if (edges.length >= 2) {
        const d0 = distToPolyline(p, edges[0]).dist;
        const d1 = distToPolyline(p, edges[1]).dist;
        const width = 300;
        alarmEl.hidden = d0 + d1 <= width + 30;
      }
    } else {
      alarmEl.hidden = true;
    }
  };

  // --- 覆盖层绘制 ---
  mv.overlay = ctx => {
    // 测量线 + 分段距离方位
    if (measurePts.length) {
      ctx.line({ pts: measurePts, color: '#ffd23a', width: 2, dash: [8, 6] });
      for (let i = 0; i < measurePts.length; i++) {
        const p = measurePts[i];
        const dot = mv.scene.atlas.discSprite('mdot', (c, s) => {
          c.beginPath(); c.arc(0, 0, s / 2 - 1, 0, Math.PI * 2);
          c.fillStyle = '#ffd23a'; c.fill();
        }, 10);
        ctx.sprite({ pos: p, sprite: dot, size: [10, 10] });
        if (i > 0) {
          const a = measurePts[i - 1];
          const d = Math.hypot(p[0] - a[0], p[1] - a[1]);
          const brg = bearing(a, p);
          const mid: Vec2 = [(a[0] + p[0]) / 2, (a[1] + p[1]) / 2];
          const sp = mv.scene.atlas.textSprite(`${fmtD(d)} ${brg.toFixed(1)}°`, 12, '#ffd23a', 'rgba(0,0,0,0.7)');
          ctx.sprite({ pos: mid, sprite: sp });
        }
      }
    }
    // 计划航线
    if (routePts.length) {
      ctx.line({ pts: routePts, color: app.palette.route, width: 3 });
      routePts.forEach((p, i) => {
        const sp = mv.scene.atlas.textSprite(`WP${i + 1}`, 11, app.palette.route, 'rgba(0,0,0,0.7)', true);
        ctx.sprite({ pos: p, sprite: sp });
      });
    }
    // 本船
    if (shipPos) {
      const ship = mv.scene.atlas.discSprite('ownship', (c, s) => {
        c.beginPath();
        c.moveTo(0, -s / 2); c.lineTo(s / 3, s / 2); c.lineTo(-s / 3, s / 2); c.closePath();
        c.fillStyle = app.palette.ownship; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = '#fff'; c.stroke();
      }, 26);
      ctx.sprite({ pos: shipPos, sprite: ship, size: [26, 26], angle: shipHeading - Math.PI / 2, mode: 2 });
    }
  };

  // --- HUD ---
  const hudTimer = setInterval(() => {
    const band = SCALE_BANDS[mv.vp.scaleBand()];
    const safety = app.settings.draft + app.settings.safetyMargin;
    hud.textContent =
      `比例尺档 ${band.name} (${mv.vp.mpp.toFixed(1)} m/px)\n` +
      `安全水深 ${safety.toFixed(1)} m · 安全等深线 ${mv.scene.safetyContourValue()} m\n` +
      `旋转 ${((-mv.vp.rotation * 180) / Math.PI % 360 + 360) % 360 | 0}°` +
      (shipPos ? `\n船位 ${shipPos[0].toFixed(0)}, ${shipPos[1].toFixed(0)}  航向 ${(bearing([0, 0], [Math.cos(shipHeading), Math.sin(shipHeading)])).toFixed(0)}°` : '') +
      (mv.scene.lastRebuildInfo ? `\n${mv.scene.lastRebuildInfo}` : '');
  }, 250);

  return () => { clearInterval(hudTimer); mv.destroy(); page.remove(); };
}
