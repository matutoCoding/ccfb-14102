// 图幅管理:生成测试图幅 → 校验(挑出坏要素)→ 入库 → 设为当前图幅
import { app } from '../app';
import { generateTestChart, validateFeatures } from '../data/testchart';
import { Projection } from '../core/geo';
import type { Feature } from '../core/types';

export function renderChartsPage(root: HTMLElement) {
  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);

  const refresh = async () => {
    await app.refreshCharts();
    draw();
  };

  const draw = () => {
    page.innerHTML = `
      <h2>图幅管理</h2>
      <div class="row">
        <button class="primary" id="gen">生成测试图幅(含坏要素)</button>
        <span class="muted">按内河电子航道图要素分类自动生成 12km 河段:岸线 / 航道边线 / 水深点 / 等深线 / 航标 / 桥梁 / 锚地 / 禁航区,并掺入自交、越界、退化要素</span>
      </div>
      <div id="genResult"></div>
      <div class="panel">
        <table>
          <thead><tr><th>图幅</th><th>要素数</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>`;
    const tbody = page.querySelector('#rows')!;
    for (const c of app.charts) {
      const tr = document.createElement('tr');
      const active = c.id === app.activeChartId;
      tr.innerHTML = `
        <td>${c.name}</td><td>${c.featureCount}</td>
        <td>${new Date(c.createdAt).toLocaleString()}</td>
        <td>${active ? '<span class="badge ok">当前图幅</span>' : ''}</td>
        <td></td>`;
      const ops = tr.lastElementChild!;
      if (!active) {
        const use = document.createElement('button');
        use.textContent = '设为当前';
        use.onclick = async () => { await app.loadChart(c.id); draw(); };
        ops.appendChild(use);
      }
      const del = document.createElement('button');
      del.textContent = '删除';
      del.className = 'danger';
      del.style.marginLeft = '6px';
      del.onclick = async () => {
        if (!confirm(`删除图幅 ${c.name}?`)) return;
        await app.store.deleteChart(c.id);
        if (app.activeChartId === c.id) {
          app.activeChartId = null;
          app.features = [];
          const rest = await app.store.listCharts();
          if (rest[0]) await app.loadChart(rest[0].id);
        }
        await refresh();
      };
      ops.appendChild(del);
      tbody.appendChild(tr);
    }
    if (!app.charts.length) tbody.innerHTML = `<tr><td colspan="5" class="muted">暂无图幅,请先生成</td></tr>`;

    page.querySelector<HTMLButtonElement>('#gen')!.onclick = async () => {
      const g = generateTestChart(true);
      const proj = new Projection(g.center);
      // 经纬度范围 → 米制校验范围
      const c0 = proj.toMeters([g.extent[0], g.extent[1]]);
      const c1 = proj.toMeters([g.extent[2], g.extent[3]]);
      const issues = validateFeatures(g.features, [c0[0], c0[1], c1[0], c1[1]]);
      const badIds = new Set(issues.map(i => i.featureId));
      const good = g.features.filter(f => !badIds.has(f.id));

      const box = page.querySelector('#genResult')!;
      box.innerHTML = `
        <div class="panel">
          <div class="row">
            <b>生成完成:${g.features.length} 个要素</b>
            <span class="badge err">${issues.length} 个坏要素</span>
            <span class="badge ok">${good.length} 个正常</span>
          </div>
          <ul class="issue-list">
            ${issues.map(i => `<li><span class="badge err">剔除</span> [${i.cls}] ${i.featureId} — ${i.problem}</li>`).join('')}
          </ul>
          <div class="row">
            <button class="primary" id="impClean">导入正常要素(${good.length})</button>
            <button id="impAll">全部导入(含坏要素,用于调试)</button>
          </div>
        </div>`;
      const doImport = async (feats: Feature[]) => {
        const id = `chart-${Date.now().toString(36)}`;
        await app.store.putChart({
          id, name: g.name, createdAt: Date.now(), center: g.center, extent: g.extent, featureCount: feats.length,
        });
        await app.store.putFeatures(id, feats);
        // 初始水深期次
        await app.store.putEpoch({ epoch: 1, date: Date.now(), label: '初始测深(生成)' });
        app.epochs = await app.store.listEpochs();
        await app.loadChart(id);
        await refresh();
      };
      box.querySelector('#impClean')!.addEventListener('click', () => doImport(good));
      box.querySelector('#impAll')!.addEventListener('click', () => doImport(g.features));
    };
  };

  draw();
  return () => { page.remove(); };
}
