// 水深更新:增量包导入/应用、按区域查更新记录、两期水深冲淤色斑图
import { app } from '../app';
import { MapView } from '../mapview';
import { generateTestUpdate } from '../data/testchart';
import { computeDepthDiff, diffToCanvas, updatesInRegion, type DiffGrid } from '../core/updates';
import type { UpdatePackage } from '../core/types';
import type { BBox, Vec2 } from '../core/geo';

export function renderDepthPage(root: HTMLElement) {
  const page = document.createElement('div');
  page.className = 'page';
  page.innerHTML = `
    <div class="row">
      <h2>水深更新</h2>
      <button class="primary" id="genPkg">生成测试更新包</button>
      <button id="impJson">从 JSON 导入</button>
      <span id="pkgInfo" class="muted"></span>
    </div>
    <div class="row grow" style="align-items:stretch">
      <div class="map-wrap" style="flex:1.5">
        <canvas class="overlay-2d" id="diffCanvas"></canvas>
        <div class="hud" id="diffHud" hidden></div>
      </div>
      <div class="panel" style="flex:1;overflow:auto" id="side"></div>
    </div>`;
  root.appendChild(page);

  const mv = new MapView(page.querySelector<HTMLElement>('.map-wrap')!);
  const side = page.querySelector<HTMLElement>('#side')!;
  const pkgInfo = page.querySelector<HTMLElement>('#pkgInfo')!;
  const diffCanvas = page.querySelector<HTMLCanvasElement>('#diffCanvas')!;
  const diffHud = page.querySelector<HTMLElement>('#diffHud')!;
  let pending: UpdatePackage | null = null;
  let queryRect: BBox | null = null;
  let queryClicks: Vec2[] = [];
  let querying = false;
  let diff: DiffGrid | null = null;
  let diffImg: HTMLCanvasElement | null = null;

  // 视野适配
  if (app.features.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of app.features) {
      if (Math.abs(f.bbox[0]) > 1e6) continue;
      x0 = Math.min(x0, f.bbox[0]); y0 = Math.min(y0, f.bbox[1]);
      x1 = Math.max(x1, f.bbox[2]); y1 = Math.max(y1, f.bbox[3]);
    }
    if (x0 < Infinity) mv.fitExtent([x0, y0, x1, y1]);
  }

  const drawSide = () => {
    const ups = [...app.updates].sort((a, b) => b.date - a.date);
    side.innerHTML = `
      <div class="row"><b>更新记录</b>
        <button id="qbtn">${querying ? '取消框选' : '框选区域查更新'}</button>
      </div>
      <div id="qresult" class="muted"></div>
      <table><thead><tr><th>更新包</th><th>日期</th><th>期次</th><th>增/删/改</th></tr></thead>
      <tbody>${ups.map(u => `
        <tr data-id="${u.id}" style="cursor:pointer">
          <td>${u.name}</td><td>${new Date(u.date).toLocaleDateString()}</td>
          <td>第${u.epoch}期</td><td>${u.adds.length}/${u.removes.length}/${u.modifies.length}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">暂无更新</td></tr>'}
      </tbody></table>
      <hr style="border-color:#262d36">
      <b>两期水深冲淤分析</b>
      <div class="row" style="margin-top:6px">
        <label>前期 <select id="epA">${app.epochs.map(e => `<option value="${e.epoch}">第${e.epoch}期</option>`).join('')}</select></label>
        <label>后期 <select id="epB">${app.epochs.map(e => `<option value="${e.epoch}">第${e.epoch}期</option>`).join('')}</select></label>
        <button id="diff">生成色斑图</button>
        <button id="clearDiff">清除</button>
      </div>
      <div class="muted" style="margin-top:6px">红=冲刷加深 · 蓝=淤积变浅;色越深处变化越大</div>`;
    side.querySelector('#qbtn')!.addEventListener('click', () => {
      querying = !querying;
      queryClicks = [];
      drawSide();
    });
    side.querySelector('#diff')!.addEventListener('click', () => {
      const ea = +side.querySelector<HTMLSelectElement>('#epA')!.value;
      const eb = +side.querySelector<HTMLSelectElement>('#epB')!.value;
      const fa = app.features.filter(f => f.cls === 'sounding' && (f.props.epoch ?? 1) === ea);
      const fb = app.features.filter(f => f.cls === 'sounding' && (f.props.epoch ?? 1) === eb);
      if (!fa.length || !fb.length) { diffHud.hidden = false; diffHud.textContent = '所选期次水深点不足'; return; }
      // 区域:两期水深点的外包
      const all = [...fa, ...fb];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of all) {
        x0 = Math.min(x0, f.bbox[0]); y0 = Math.min(y0, f.bbox[1]);
        x1 = Math.max(x1, f.bbox[2]); y1 = Math.max(y1, f.bbox[3]);
      }
      diff = computeDepthDiff(fa, fb, [x0, y0, x1, y1], 80);
      diffImg = diffToCanvas(diff, app.palette.erosion, app.palette.siltation);
      diffHud.hidden = false;
      diffHud.textContent = `冲淤差值:第${ea}期 → 第${eb}期 · 最大变化 ${diff.maxAbs.toFixed(1)} m`;
    });
    side.querySelector('#clearDiff')!.addEventListener('click', () => {
      diff = null; diffImg = null; diffHud.hidden = true;
    });
    side.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.addEventListener('click', () => {
        const u = app.updates.find(x => x.id === (tr as HTMLElement).dataset.id);
        if (u) { queryRect = u.region; mv.fitExtent(u.region); }
      });
    });
    if (queryRect) {
      const hits = updatesInRegion(app.updates, queryRect);
      const qr = side.querySelector('#qresult')!;
      qr.innerHTML = `该区域共有 <b>${hits.length}</b> 次更新:` +
        hits.map(h => `<br>· ${new Date(h.date).toLocaleDateString()} ${h.name}`).join('');
    }
  };

  // 更新包生成 / 导入 / 应用
  const showPending = (pkg: UpdatePackage) => {
    pending = pkg;
    pkgInfo.innerHTML = `待应用:<b>${pkg.name}</b>(新增 ${pkg.adds.length} / 删除 ${pkg.removes.length} / 修改 ${pkg.modifies.length})`;
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = '应用增量包';
    btn.onclick = async () => {
      await app.applyUpdatePackage(pkg);
      pkgInfo.innerHTML = `<span class="badge ok">已应用</span> ${mv.scene.lastRebuildInfo}(只重建受影响图层,未整图重算)`;
      pending = null;
      queryRect = pkg.region;
      mv.fitExtent(pkg.region);
      drawSide();
    };
    pkgInfo.appendChild(btn);
  };
  page.querySelector('#genPkg')!.addEventListener('click', () => {
    if (!app.features.length) { pkgInfo.textContent = '请先在图幅管理生成图幅'; return; }
    showPending(generateTestUpdate(app.features));
  });
  page.querySelector('#impJson')!.addEventListener('click', () => {
    const ta = document.createElement('textarea');
    ta.placeholder = '粘贴更新包 JSON(含 adds/removes/modifies/region/epoch)';
    ta.style.cssText = 'width:100%;height:120px';
    const ok = document.createElement('button');
    ok.textContent = '解析并暂存';
    ok.onclick = () => {
      try {
        const pkg = JSON.parse(ta.value) as UpdatePackage;
        pkg.id = pkg.id || `upd-${Date.now().toString(36)}`;
        pkg.date = pkg.date || Date.now();
        showPending(pkg);
        ta.remove(); ok.remove();
      } catch (e) { alert(`JSON 解析失败:${e}`); }
    };
    side.prepend(ok, ta);
  });

  // 框选查询
  mv.onClick = w => {
    if (!querying) return;
    queryClicks.push(w);
    if (queryClicks.length === 2) {
      const [a, b] = queryClicks;
      queryRect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      querying = false;
      queryClicks = [];
      drawSide();
    }
  };

  // 覆盖层:更新范围框 + 框选矩形
  mv.overlay = ctx => {
    const drawRect = (r: BBox, color: string) => {
      ctx.line({ pts: [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]], [r[0], r[1]]], color, width: 2, dash: [10, 6] });
    };
    if (queryRect) drawRect(queryRect, '#ffd23a');
    if (pending) drawRect(pending.region, '#ff8c00');
    if (queryClicks.length === 1) {
      const d = mv.scene.atlas.discSprite('qdot', (c, s) => {
        c.beginPath(); c.arc(0, 0, s / 2 - 1, 0, Math.PI * 2); c.fillStyle = '#ffd23a'; c.fill();
      }, 10);
      ctx.sprite({ pos: queryClicks[0], sprite: d, size: [10, 10] });
    }
  };

  // 冲淤色斑图:2D 覆盖画布,按视口变换贴图
  const dctx = diffCanvas.getContext('2d')!;
  mv.onFrame = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = diffCanvas.clientWidth, H = diffCanvas.clientHeight;
    if (diffCanvas.width !== W * dpr) { diffCanvas.width = W * dpr; diffCanvas.height = H * dpr; }
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, diffCanvas.width, diffCanvas.height);
    if (!diff || !diffImg) return;
    const vp = mv.vp;
    const c = Math.cos(vp.rotation), s = Math.sin(vp.rotation);
    const x0 = diff.x0, y1 = diff.y0 + diff.rows * diff.cell;
    const cell = diff.cell, mpp = vp.mpp;
    const a = (c * cell) / mpp * dpr, b = (-s * cell) / mpp * dpr;
    const cc = (s * cell) / mpp * dpr, d = (c * cell) / mpp * dpr;
    const e = ((c * (x0 - vp.cx) - s * (y1 - vp.cy)) / mpp + vp.width / 2) * dpr;
    const f = (-(s * (x0 - vp.cx) + c * (y1 - vp.cy)) / mpp + vp.height / 2) * dpr;
    dctx.imageSmoothingEnabled = true;
    dctx.setTransform(a, b, cc, d, e, f);
    dctx.drawImage(diffImg, 0, 0);
  };

  drawSide();
  app.on('updates', drawSide);
  return () => { mv.destroy(); page.remove(); };
}
