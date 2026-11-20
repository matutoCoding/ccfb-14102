// 航标维护:列表 + 图上拖拽改位置 + 灯质/状态编辑
import { app } from '../app';
import { MapView } from '../mapview';
import type { Feature, BuoyProps, LightChar } from '../core/types';
import { lightLabel } from '../core/lights';
import type { Vec2 } from '../core/geo';

export function renderBuoysPage(root: HTMLElement) {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="row">
      <h2>航标维护</h2>
      <span class="muted">在图上拖拽航标改位置;点选航标后在下方编辑灯质与状态</span>
      <span id="saveTip" class="badge ok" hidden>已保存</span>
    </div>
    <div class="row grow" style="align-items:stretch">
      <div class="map-wrap" style="flex:1.4"></div>
      <div class="panel" style="flex:1;overflow:auto">
        <table>
          <thead><tr><th>名称</th><th>类型</th><th>灯质</th><th>状态</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
    </div>
    <div class="panel" id="editor" hidden></div>`;
  root.appendChild(page);

  const mv = new MapView(page.querySelector<HTMLElement>('.map-wrap')!);
  const tbody = page.querySelector<HTMLElement>('#rows')!;
  const editor = page.querySelector<HTMLElement>('#editor')!;
  const saveTip = page.querySelector<HTMLElement>('#saveTip')!;
  let selected: Feature | null = null;
  let dragging: Feature | null = null;

  const buoys = () => app.features.filter(f => f.cls === 'buoy');

  const drawTable = () => {
    tbody.innerHTML = '';
    for (const f of buoys()) {
      const bp = f.props.buoy as BuoyProps;
      const tr = document.createElement('tr');
      const statusTxt = bp.status === 'normal' ? '<span class="badge ok">正常</span>'
        : bp.status === 'shifted' ? '<span class="badge warn">移位</span>'
        : '<span class="badge err">漂失</span>';
      tr.innerHTML = `<td>${bp.name}</td><td>${bp.shape}</td><td>${lightLabel(bp.light)}</td><td>${statusTxt}</td>`;
      if (selected?.id === f.id) tr.style.background = '#1b3049';
      tr.onclick = () => { selected = f; drawTable(); drawEditor(); centerOn(f); };
      tbody.appendChild(tr);
    }
  };
  const centerOn = (f: Feature) => {
    if (f.geom.kind !== 'point') return;
    mv.vp.cx = f.geom.xy[0]; mv.vp.cy = f.geom.xy[1];
    if (mv.vp.mpp > 6) mv.vp.mpp = 6;
  };

  const drawEditor = () => {
    if (!selected) { editor.hidden = true; return; }
    const bp = selected.props.buoy as BuoyProps;
    editor.hidden = false;
    editor.innerHTML = `
      <div class="row">
        <b>${bp.name}</b>
        <label>状态
          <select id="st">
            <option value="normal">正常</option>
            <option value="shifted">移位</option>
            <option value="drifted">漂失</option>
          </select>
        </label>
        <label>灯质
          <select id="lc">
            <option value="Q">快闪</option>
            <option value="VQ">甚快闪</option>
            <option value="LFl">长闪 10s</option>
            <option value="Fl1">单闪 4s</option>
            <option value="Fl3">联闪(3) 6s</option>
            <option value="MoA">莫尔斯 A 12s</option>
            <option value="Iso">等明暗 4s</option>
            <option value="Oc">互光 8s</option>
            <option value="none">无灯</option>
          </select>
        </label>
        <button class="primary" id="save">保存</button>
      </div>`;
    const st = editor.querySelector<HTMLSelectElement>('#st')!;
    const lc = editor.querySelector<HTMLSelectElement>('#lc')!;
    st.value = bp.status;
    const cur = !bp.light ? 'none'
      : bp.light.kind === 'Fl' ? (bp.light.count > 1 ? 'Fl3' : 'Fl1')
      : bp.light.kind === 'Mo' ? 'MoA' : bp.light.kind;
    lc.value = cur;
    editor.querySelector('#save')!.addEventListener('click', async () => {
      const lightMap: Record<string, LightChar | null> = {
        Q: { kind: 'Q', period: 1 }, VQ: { kind: 'VQ', period: 0.5 },
        LFl: { kind: 'LFl', period: 10 }, Fl1: { kind: 'Fl', period: 4, count: 1 },
        Fl3: { kind: 'Fl', period: 6, count: 3 }, MoA: { kind: 'Mo', code: 'A', period: 12 },
        Iso: { kind: 'Iso', period: 4 }, Oc: { kind: 'Oc', period: 8 }, none: null,
      };
      bp.status = st.value as BuoyProps['status'];
      bp.light = lightMap[lc.value];
      await app.saveFeature(selected!);
      saveTip.hidden = false;
      setTimeout(() => (saveTip.hidden = true), 1500);
      drawTable();
    });
  };

  // 图上点选 + 拖拽
  const hitBuoy = (w: Vec2): Feature | null => {
    let best: Feature | null = null, bestD = 20 * mv.vp.mpp; // 20px 命中半径
    for (const f of buoys()) {
      if (f.geom.kind !== 'point') continue;
      const d = Math.hypot(f.geom.xy[0] - w[0], f.geom.xy[1] - w[1]);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  };
  mv.onDragFeature = (w, kind) => {
    if (kind === 'down') {
      const f = hitBuoy(w);
      if (f) { dragging = f; selected = f; drawTable(); drawEditor(); return true; }
      return false;
    }
    if (!dragging) return false;
    if (kind === 'move' && dragging.geom.kind === 'point') {
      dragging.geom.xy = [w[0], w[1]];
      dragging.bbox = [w[0], w[1], w[0], w[1]];
      mv.scene.setFeatures(app.features); // 触发符号重建(仅航标类每帧动态,开销小)
      return true;
    }
    if (kind === 'up') {
      if (dragging) {
        const f = dragging;
        dragging = null;
        void app.saveFeature(f);
        saveTip.hidden = false;
        setTimeout(() => (saveTip.hidden = true), 1500);
      }
      return true;
    }
    return false;
  };

  // 选中高亮圈
  mv.overlay = ctx => {
    if (selected && selected.geom.kind === 'point') {
      const ring = mv.scene.atlas.discSprite('sel', (c, s) => {
        c.beginPath(); c.arc(0, 0, s / 2 - 2, 0, Math.PI * 2);
        c.lineWidth = 2.5; c.strokeStyle = '#4fb3ff'; c.stroke();
      }, 40);
      ctx.sprite({ pos: selected.geom.xy, sprite: ring, size: [40, 40] });
    }
  };

  drawTable();
  app.on('features', drawTable);
  return () => { mv.destroy(); page.remove(); };
}
