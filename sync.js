const API = 'https://sync.tangkk-x2o.com/v1/video-podcasts/state';
const recordPattern = /^(favorite|progress):[A-Za-z0-9_-]{1,110}$/;

function records(raw) {
  if (!Array.isArray(raw)) return new Map();
  const valid = raw.filter(item => {
    if (!item || typeof item.key !== 'string' || !recordPattern.test(item.key) ||
        !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) return false;
    return item.key.startsWith('favorite:')
      ? typeof item.value === 'boolean'
      : Number.isSafeInteger(item.value) && item.value >= 0;
  });
  return new Map(valid.map(item => [item.key, item]));
}

export function setupSync({ readLocal, writeLocal, onState }) {
  const button = document.querySelector('#sync-toggle');
  const panel = document.querySelector('#sync-panel');
  const form = panel.querySelector('form');
  const input = panel.querySelector('#sync-key');
  const status = panel.querySelector('#sync-status');
  const syncNow = panel.querySelector('#sync-now');
  const disconnect = panel.querySelector('#sync-disconnect');
  const savedKey = readLocal('sync-key', '');
  let activeKey = typeof savedKey === 'string' ? savedKey : '';
  let remote = new Map();
  let busy = false;
  let queued = false;
  let timer = null;

  const previous = readLocal('sync-records', null);
  const oldFavorites = readLocal('favorites', []);
  const items = records(previous ?? [
    ...(Array.isArray(oldFavorites) ? oldFavorites : []).map(id => ({
      key: `favorite:${id}`, value: true, updatedAt: 1
    })),
    ...Object.entries(readLocal('progress', {})).map(([id, entry]) => ({
      key: `progress:${id}`, value: entry?.seconds, updatedAt: entry?.updatedAt
    }))
  ]);
  let visibleFavorites = '';
  let visibleProgress = '';
  function apply() {
    const favorites = [];
    const progress = Object.create(null);
    for (const item of items.values()) {
      if (item.key.startsWith('favorite:') && item.value) favorites.push(item.key.slice(9));
      if (item.key.startsWith('progress:') && item.value) {
        progress[item.key.slice(9)] = { seconds: item.value, updatedAt: item.updatedAt };
      }
    }
    favorites.sort();
    const nextFavorites = JSON.stringify(favorites);
    const nextProgress = JSON.stringify(progress);
    const favoritesChanged = nextFavorites !== visibleFavorites;
    const progressChanged = nextProgress !== visibleProgress;
    visibleFavorites = nextFavorites;
    visibleProgress = nextProgress;
    onState({ favorites, progress, favoritesChanged, progressChanged });
  }

  function persist() {
    writeLocal('sync-records', [...items.values()]);
    apply();
  }

  function merge(incoming) {
    let changed = false;
    for (const [key, item] of incoming) {
      const previous = items.get(key);
      if (!previous || item.updatedAt > previous.updatedAt ||
          (item.updatedAt === previous.updatedAt && item.value !== previous.value)) {
        items.set(key, item);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function schedule(delay = 800) {
    if (activeKey && timer === null) timer = setTimeout(() => {
      timer = null;
      void synchronize();
    }, delay);
  }

  function change(key, value, delay) {
    merge(records(readLocal('sync-records', [])));
    const old = items.get(key);
    if (old?.value === value) return;
    items.set(key, { key, value, updatedAt: Math.max(Date.now(), (old?.updatedAt ?? 0) + 1) });
    persist();
    schedule(delay);
  }

  function outgoing() {
    return [...items.values()].filter(item => !remote.has(item.key) ||
      item.updatedAt > remote.get(item.key).updatedAt);
  }

  async function request(key, batch, keepalive = false) {
    const response = await fetch(API, {
      method: batch ? 'POST' : 'GET',
      cache: 'no-store',
      keepalive,
      signal: AbortSignal.timeout(12000),
      headers: {
        'X-Sync-Key': key,
        ...(batch ? { 'Content-Type': 'application/json' } : {})
      },
      body: batch ? JSON.stringify({ items: batch }) : undefined
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.items)) throw new Error('同步回應格式錯誤');
    return records(data.items);
  }

  function updateStatus(message) {
    status.textContent = message;
    button.textContent = activeKey ? '同步 ✓' : '同步';
    syncNow.disabled = busy || !activeKey;
    disconnect.disabled = busy || !activeKey;
    panel.querySelector('[type="submit"]').disabled = busy;
  }

  async function synchronize(key = activeKey, binding = false) {
    if (!key) return;
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    let message = '';
    updateStatus('正在同步…');
    try {
      const fetched = await request(key);
      if (binding) {
        activeKey = key;
        writeLocal('sync-key', key);
      }
      remote = fetched;
      merge(remote);
      merge(records(readLocal('sync-records', [])));
      const batch = outgoing();
      for (let offset = 0; offset < batch.length; offset += 100) {
        remote = await request(key, batch.slice(offset, offset + 100));
        merge(remote);
      }
      message = `已同步 · ${new Date().toLocaleTimeString('zh-Hant', { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      message = '同步失敗，稍後會再試。';
    } finally {
      busy = false;
      updateStatus(message);
      if (queued) {
        queued = false;
        schedule();
      }
    }
  }

  button.addEventListener('click', () => {
    input.value = activeKey;
    panel.showModal();
  });
  panel.querySelector('#sync-close').addEventListener('click', () => panel.close());
  panel.querySelector('#sync-generate').addEventListener('click', () => {
    input.value = crypto.randomUUID();
    input.focus();
    input.select();
  });
  panel.querySelector('#sync-copy').addEventListener('click', async () => {
    if (!input.value.trim()) return;
    try {
      await navigator.clipboard.writeText(input.value.trim());
      updateStatus('已複製同步碼');
    } catch {
      input.focus();
      input.select();
      updateStatus('請複製選取的同步碼');
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const key = input.value.trim();
    if (!/^[\x21-\x7e]{1,256}$/.test(key)) {
      updateStatus('請輸入同步碼，或產生一組新的同步碼。同步碼可用英數和標點。');
      return;
    }
    void synchronize(key, true);
  });
  syncNow.addEventListener('click', () => void synchronize());
  disconnect.addEventListener('click', () => {
    activeKey = '';
    remote = new Map();
    clearTimeout(timer);
    timer = null;
    writeLocal('sync-key', '');
    input.value = '';
    updateStatus('此裝置已中斷同步，本機記錄仍保留。');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void synchronize();
  });
  window.addEventListener('online', () => void synchronize());
  window.addEventListener('pagehide', () => {
    const batch = outgoing().slice(0, 100);
    if (activeKey && batch.length) void request(activeKey, batch, true).catch(() => {});
  });
  window.addEventListener('storage', event => {
    if (event.key === 'video-podcasts:sync-records') {
      merge(records(readLocal('sync-records', [])));
    }
  });
  window.setInterval(() => { if (!document.hidden) void synchronize(); }, 30000);

  apply();
  updateStatus(activeKey ? '此裝置已開啟同步' : '尚未設定同步碼');
  schedule(0);
  return {
    favorite: (id, value) => change(`favorite:${id}`, value, 800),
    position: (id, seconds, immediate) => change(`progress:${id}`, seconds, immediate ? 500 : 8000),
    flushSoon: () => {
      clearTimeout(timer);
      timer = null;
      schedule(200);
    }
  };
}
