// 入口:布局 + hash 路由
import './style.css';
import { app } from './app';
import { renderChartsPage } from './pages/charts';
import { renderMapPage } from './pages/map';
import { renderBuoysPage } from './pages/buoys';
import { renderDepthPage } from './pages/depth';
import { renderSettingsPage } from './pages/settings';

const PAGES: [string, string, (root: HTMLElement) => () => void][] = [
  ['charts', '图幅管理', renderChartsPage],
  ['map', '航道图显示', renderMapPage],
  ['buoys', '航标维护', renderBuoysPage],
  ['depth', '水深更新', renderDepthPage],
  ['settings', '显示设置', renderSettingsPage],
];

async function boot() {
  const appEl = document.getElementById('app')!;
  const nav = document.createElement('nav');
  nav.innerHTML = `<div class="brand">内河电子航道图<br>渲染系统</div>` +
    PAGES.map(([id, name]) => `<a href="#${id}" data-id="${id}">${name}</a>`).join('');
  const main = document.createElement('main');
  appEl.append(nav, main);

  await app.init();

  let cleanup: (() => void) | null = null;
  const route = () => {
    const hash = location.hash.slice(1) || 'charts';
    const page = PAGES.find(p => p[0] === hash) ?? PAGES[0];
    nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', (a as HTMLElement).dataset.id === page[0]));
    cleanup?.();
    main.innerHTML = '';
    cleanup = page[2](main);
  };
  window.addEventListener('hashchange', route);
  route();
}

void boot();
