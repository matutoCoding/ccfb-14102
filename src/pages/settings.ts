// 显示设置:调色板、吃水/富余、注记开关、模拟船速
import { app } from '../app';

export function renderSettingsPage(root: HTMLElement) {
  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);

  const draw = () => {
    const s = app.settings;
    page.innerHTML = `
      <h2>显示设置</h2>
      <div class="panel" style="max-width:560px;display:flex;flex-direction:column;gap:14px">
        <div class="row"><label style="width:120px">调色板</label>
          <select id="palette">
            <option value="day">白天</option>
            <option value="dusk">黄昏</option>
            <option value="night">夜间</option>
          </select>
          <span class="muted">夜间整体压暗,红绿侧标保持可区分</span>
        </div>
        <div class="row"><label style="width:120px">本船吃水 (m)</label>
          <input id="draft" type="number" step="0.1" min="0.5" max="8" value="${s.draft}">
          <span class="muted">改动后全图安全水深实时重算</span>
        </div>
        <div class="row"><label style="width:120px">富余水深 (m)</label>
          <input id="margin" type="number" step="0.1" min="0" max="3" value="${s.safetyMargin}">
        </div>
        <div class="row"><label style="width:120px">安全水深</label>
          <b id="safetyVal">${(s.draft + s.safetyMargin).toFixed(1)} m</b>
        </div>
        <div class="row"><label style="width:120px">水深点注记</label>
          <input id="showSoundings" type="checkbox" ${s.showSoundings ? 'checked' : ''}>
        </div>
        <div class="row"><label style="width:120px">地物注记</label>
          <input id="showLabels" type="checkbox" ${s.showLabels ? 'checked' : ''}>
        </div>
        <div class="row"><label style="width:120px">模拟船速 (节)</label>
          <input id="simSpeed" type="number" step="1" min="1" max="20" value="${s.simSpeedKn}">
        </div>
        <div class="row"><span id="saved" class="badge ok" hidden>已保存并生效</span></div>
      </div>`;
    const $ = <T extends HTMLElement>(id: string) => page.querySelector<T>(id)!;
    $<HTMLSelectElement>('#palette').value = s.palette;
    const saved = $('#saved');
    const notify = () => { saved.hidden = false; setTimeout(() => (saved.hidden = true), 1200); };
    $('#palette').addEventListener('change', async () => {
      await app.updateSetting({ palette: $<HTMLSelectElement>('#palette').value as 'day' | 'dusk' | 'night' });
      notify();
    });
    $('#draft').addEventListener('change', async () => {
      await app.updateSetting({ draft: +$<HTMLInputElement>('#draft').value || 0.5 });
      $('#safetyVal').textContent = `${(app.settings.draft + app.settings.safetyMargin).toFixed(1)} m`;
      notify();
    });
    $('#margin').addEventListener('change', async () => {
      await app.updateSetting({ safetyMargin: +$<HTMLInputElement>('#margin').value || 0 });
      $('#safetyVal').textContent = `${(app.settings.draft + app.settings.safetyMargin).toFixed(1)} m`;
      notify();
    });
    $('#showSoundings').addEventListener('change', async () => {
      await app.updateSetting({ showSoundings: $<HTMLInputElement>('#showSoundings').checked });
      notify();
    });
    $('#showLabels').addEventListener('change', async () => {
      await app.updateSetting({ showLabels: $<HTMLInputElement>('#showLabels').checked });
      notify();
    });
    $('#simSpeed').addEventListener('change', async () => {
      await app.updateSetting({ simSpeedKn: +$<HTMLInputElement>('#simSpeed').value || 8 });
      notify();
    });
  };
  draw();
  return () => { page.remove(); };
}
