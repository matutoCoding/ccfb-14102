// 应用级状态:数据库、设置、当前图幅、要素缓存、事件总线
import { Store } from './db/db';
import type { Settings, Feature, ChartMeta, UpdatePackage, DepthEpoch } from './core/types';
import { DEFAULT_SETTINGS } from './core/types';
import { PALETTES, type Palette } from './core/palette';

type Handler = () => void;

class AppState {
  store = new Store();
  settings: Settings = { ...DEFAULT_SETTINGS };
  charts: ChartMeta[] = [];
  activeChartId: string | null = null;
  features: Feature[] = [];
  updates: UpdatePackage[] = [];
  epochs: DepthEpoch[] = [];
  lastDelta: UpdatePackage | null = null;
  private handlers = new Map<string, Handler[]>();

  on(event: 'settings' | 'features' | 'charts' | 'updates' | 'delta', h: Handler) {
    (this.handlers.get(event) ?? this.handlers.set(event, []).get(event)!).push(h);
  }
  emit(event: string) { for (const h of this.handlers.get(event) ?? []) h(); }

  get palette(): Palette { return PALETTES[this.settings.palette]; }

  async init() {
    await this.store.open();
    this.settings = await this.store.loadSettings();
    this.charts = await this.store.listCharts();
    this.updates = await this.store.listUpdates();
    this.epochs = await this.store.listEpochs();
    if (this.charts.length && !this.activeChartId) {
      await this.loadChart(this.charts[0].id);
    }
  }

  async refreshCharts() { this.charts = await this.store.listCharts(); this.emit('charts'); }

  async loadChart(id: string) {
    this.activeChartId = id;
    this.features = await this.store.getFeatures(id);
    this.emit('features');
  }

  async updateSetting(patch: Partial<Settings>) {
    Object.assign(this.settings, patch);
    await this.store.saveSettings(this.settings);
    this.emit('settings');
  }

  async applyUpdatePackage(pkg: UpdatePackage) {
    // 落到 DB
    for (const id of pkg.removes) await this.store.removeFeature(this.activeChartId!, id);
    for (const m of pkg.modifies) await this.store.putFeature(this.activeChartId!, m);
    await this.store.putFeatures(this.activeChartId!, pkg.adds);
    await this.store.putUpdate(pkg);
    if (!this.epochs.some(e => e.epoch === pkg.epoch)) {
      const ep: DepthEpoch = { epoch: pkg.epoch, date: pkg.date, label: pkg.name };
      await this.store.putEpoch(ep);
      this.epochs = await this.store.listEpochs();
    }
    this.updates = await this.store.listUpdates();
    // 内存要素
    const rm = new Set(pkg.removes);
    this.features = this.features.filter(f => !rm.has(f.id));
    const byId = new Map(this.features.map(f => [f.id, f] as const));
    for (const m of pkg.modifies) byId.set(m.id, m);
    this.features = [...byId.values(), ...pkg.adds];
    this.lastDelta = pkg;
    this.emit('delta');
    this.emit('updates');
  }

  async saveFeature(f: Feature) {
    await this.store.putFeature(this.activeChartId!, f);
    const i = this.features.findIndex(x => x.id === f.id);
    if (i >= 0) this.features[i] = f; else this.features.push(f);
    this.emit('features');
  }
}

export const app = new AppState();
