// IndexedDB 持久层:图幅、要素、增量包、水深期次、设置
import type { ChartMeta, Feature, UpdatePackage, DepthEpoch, Settings } from '../core/types';
import { DEFAULT_SETTINGS } from '../core/types';

const DB_NAME = 'inland-ecdis';
const DB_VER = 1;

export class Store {
  private db!: IDBDatabase;

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('charts', { keyPath: 'id' });
        const feats = db.createObjectStore('features', { keyPath: 'key' }); // key = chartId:featureId
        feats.createIndex('byChart', 'chartId', { unique: false });
        db.createObjectStore('updates', { keyPath: 'id' });
        db.createObjectStore('epochs', { keyPath: 'epoch' });
        db.createObjectStore('settings', { keyPath: 'name' });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  private tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async putChart(meta: ChartMeta): Promise<void> { await this.tx('charts', 'readwrite', s => s.put(meta)); }
  async listCharts(): Promise<ChartMeta[]> {
    return this.tx<ChartMeta[]>('charts', 'readonly', s => s.getAll() as IDBRequest<ChartMeta[]>);
  }
  async deleteChart(id: string): Promise<void> {
    await this.tx('charts', 'readwrite', s => s.delete(id));
    const feats = await this.getFeatures(id);
    await Promise.all(feats.map(f => this.tx('features', 'readwrite', s => s.delete(`${id}:${f.id}`))));
  }

  async putFeatures(chartId: string, feats: Feature[]): Promise<void> {
    const t = this.db.transaction('features', 'readwrite');
    const s = t.objectStore('features');
    for (const f of feats) s.put({ key: `${chartId}:${f.id}`, chartId, feature: f });
    await new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  }
  async getFeatures(chartId: string): Promise<Feature[]> {
    const rows = await this.tx<{ feature: Feature }[]>('features', 'readonly', s => {
      const idx = s.index('byChart');
      return idx.getAll(chartId) as IDBRequest<{ feature: Feature }[]>;
    });
    return rows.map(r => r.feature);
  }
  async putFeature(chartId: string, f: Feature): Promise<void> {
    await this.tx('features', 'readwrite', s => s.put({ key: `${chartId}:${f.id}`, chartId, feature: f }));
  }
  async removeFeature(chartId: string, fid: string): Promise<void> {
    await this.tx('features', 'readwrite', s => s.delete(`${chartId}:${fid}`));
  }

  async putUpdate(u: UpdatePackage): Promise<void> { await this.tx('updates', 'readwrite', s => s.put(u)); }
  async listUpdates(): Promise<UpdatePackage[]> {
    return this.tx<UpdatePackage[]>('updates', 'readonly', s => s.getAll() as IDBRequest<UpdatePackage[]>);
  }

  async putEpoch(e: DepthEpoch): Promise<void> { await this.tx('epochs', 'readwrite', s => s.put(e)); }
  async listEpochs(): Promise<DepthEpoch[]> {
    const all = await this.tx<DepthEpoch[]>('epochs', 'readonly', s => s.getAll() as IDBRequest<DepthEpoch[]>);
    return all.sort((a, b) => a.epoch - b.epoch);
  }

  async saveSettings(s: Settings): Promise<void> {
    await this.tx('settings', 'readwrite', st => st.put({ name: 'settings', value: s }));
  }
  async loadSettings(): Promise<Settings> {
    const row = await this.tx<{ value: Settings } | undefined>('settings', 'readonly', s =>
      s.get('settings') as IDBRequest<{ value: Settings } | undefined>);
    return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
  }
}
