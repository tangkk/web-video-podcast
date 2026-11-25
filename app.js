import { setupSync } from './sync.js';

const $ = selector => document.querySelector(selector);
const elements = {
  search: $('#search'), languages: $('#languages'), topics: $('#topics'),
  browse: $('#browse'), directory: $('#directory'), summary: $('#summary'),
  detail: $('#detail'), favorites: $('#favorites'), recent: $('#recent'),
  watch: $('#watch'), screen: $('#screen'), chapters: $('#chapters'),
  watchTitle: $('#watch-title'), watchShow: $('#watch-show'), watchState: $('#watch-state'), source: $('#source')
};
const languages = { all: '全部', en: '英語', cmn: '國語', yue: '粵語' };
const topics = {
  all: '全部', current: '時事', tech: '科技與商業',
  culture: '文化與歷史', science: '科學健康', people: '人物與生活'
};

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(`video-podcasts:${key}`)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(`video-podcasts:${key}`, JSON.stringify(value));
  } catch {
    // The catalog also works when browser storage is unavailable.
  }
}

const favorites = new Set();
const progress = new Map();
const state = { language: 'all', topic: 'all', view: 'episodes', favoritesOnly: false };
let shows = new Map();
let episodes = new Map();
let current = null;
let youtubeApi;
let focusAfterClose;
let detailId = '';
let detailPage = 1;
let detailSearch = '';
let detailOrder = 'newest';
const DETAIL_PAGE_SIZE = 24;
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const normalize = value => value.normalize('NFKC').toLocaleLowerCase();
const date = value => new Intl.DateTimeFormat('zh-Hant', {
  timeZone: 'UTC', year: 'numeric',
  ...(value.length >= 7 ? { month: 'short' } : {}),
  ...(value.length === 10 ? { day: 'numeric' } : {})
}).format(new Date(value));

function time(seconds) {
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole % 3600 / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function publicUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function episodeUrl(episode) {
  return episode.youtube ? `https://www.youtube.com/watch?v=${episode.youtube}` : publicUrl(episode.url);
}

function makeChips(container, choices, active) {
  container.innerHTML = Object.entries(choices).map(([id, label]) =>
    `<button class="chip" type="button" data-filter="${id}" aria-pressed="${id === active}">${label}</button>`
  ).join('');
}

function updateChips(container, value) {
  for (const button of container.children) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === value));
  }
}

function favoriteButton(show) {
  const active = favorites.has(show.id);
  return `<button class="icon" type="button" data-favorite="${show.id}" aria-label="收藏 ${escape(show.name)}" aria-pressed="${active}">${active ? '★' : '☆'}</button>`;
}

function episodeCard(episode) {
  const show = shows.get(episode.showId);
  const title = escape(episode.title);
  const reference = episode.youtube
    ? `<img src="https://i.ytimg.com/vi/${episode.youtube}/mqdefault.jpg" alt="" loading="lazy"><span class="play-mark" aria-hidden="true">▶</span>`
    : '<span class="play-mark source-mark" aria-hidden="true">▶</span>';
  const cover = episode.youtube
    ? `<button class="cover" type="button" data-watch="${episode.id}" aria-label="播放 ${title}">${reference}</button>`
    : `<a class="cover" href="${escape(episodeUrl(episode))}" target="_blank" rel="noopener noreferrer" aria-label="在原平台觀看 ${title}">${reference}</a>`;
  const titleLink = episode.youtube
    ? `<button class="title-link" type="button" data-watch="${episode.id}">${title}</button>`
    : `<a class="title-link" href="${escape(episodeUrl(episode))}" target="_blank" rel="noopener noreferrer">${title}</a>`;
  const details = [date(episode.publishedAt), languages[show.language]];
  if (episode.duration) details.push(time(episode.duration));
  if (!episode.youtube) details.push('原平台');
  return `<article class="card">
    ${cover}
    <div class="card-copy">
      <a class="show-link" href="#show/${show.id}">${escape(show.name)}</a>
      <h2>${titleLink}</h2>
      <p class="meta">${details.join(' · ')}</p>
    </div>
  </article>`;
}

function showCard(show) {
  const count = show.episodes.length;
  const meta = `${languages[show.language]} · ${escape(show.topic)} · ${count ? `${count} 集` : '官方目錄'}`;
  const initials = { en: 'EN', cmn: '國', yue: '粵' };
  return `<article class="card show-card">
    <span class="show-tile" aria-hidden="true">${initials[show.language]}</span>
    <div class="card-copy"><h2><a class="title-link" href="#show/${show.id}">${escape(show.name)}</a></h2><p class="meta">${meta}</p></div>
    ${favoriteButton(show)}
  </article>`;
}

function renderRecent() {
  const recent = [...progress.entries()].filter(([id]) => episodes.has(id))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 6);
  $('#continue').hidden = !recent.length;
  elements.recent.innerHTML = recent.map(([id, entry]) =>
    `<button class="pill" type="button" data-watch="${id}">${escape(episodes.get(id).title)} · ${time(entry.seconds)}</button>`
  ).join('');
}

function render() {
  updateChips(elements.languages, state.language);
  updateChips(elements.topics, state.topic);
  elements.favorites.setAttribute('aria-pressed', String(state.favoritesOnly));
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.view === state.view));
  }
  const query = normalize(elements.search.value.trim());
  const matches = show => (state.language === 'all' || show.language === state.language)
    && (state.topic === 'all' || state.topic === show.category)
    && (!state.favoritesOnly || favorites.has(show.id));
  const matching = [...shows.values()].filter(matches);
  if (state.view === 'shows') {
    const items = matching.filter(show => normalize(`${show.name} ${show.topic} ${show.episodes.map(item => item.title).join(' ')}`).includes(query));
    elements.summary.textContent = `${items.length} 檔節目`;
    elements.directory.innerHTML = items.map(showCard).join('');
  } else {
    const items = matching.flatMap(show => show.episodes.filter(item =>
      normalize(`${item.title} ${show.name} ${show.topic}`).includes(query)
    )).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    elements.summary.textContent = `${items.length} 集影片`;
    elements.directory.innerHTML = items.map(episodeCard).join('');
  }
  if (!elements.directory.children.length) {
    const message = state.favoritesOnly ? '沒有符合條件的收藏。' : '沒有符合條件的內容。';
    elements.directory.innerHTML = `<p class="empty">${message}</p>`;
  }
}

function renderShowEpisodes(show) {
  const query = normalize(detailSearch.trim());
  let matching = show.episodes.filter(episode =>
    normalize(episode.title + ' ' + (episode.title.match(/#\\d+/)?.[0] || '')).includes(query)
  );
  if (detailOrder === 'oldest') matching = [...matching].reverse();
  const visible = matching.slice(0, detailPage * DETAIL_PAGE_SIZE);
  const list = elements.detail.querySelector('[data-show-episodes]');
  if (!list) return;
  list.innerHTML = visible.map(episodeCard).join('') ||
    '<p class="empty">沒有符合條件的單集。</p>';
  const status = elements.detail.querySelector('[data-episode-count]');
  status.textContent = '顯示 ' + visible.length + ' / ' + matching.length + ' 集';
  elements.detail.querySelector('[data-load-more]').hidden = visible.length >= matching.length;
}

function renderRoute() {
  const id = /^#show\\/([a-z0-9-]+)$/.exec(location.hash)?.[1];
  const show = shows.get(id);
  elements.browse.hidden = Boolean(show);
  elements.detail.hidden = !show;
  $('.toolbar').hidden = Boolean(show);
  renderRecent();
  if (!show) {
    detailId = '';
    elements.detail.replaceChildren();
    return;
  }
  $('#continue').hidden = true;
  if (detailId === id) {
    renderShowEpisodes(show);
    return;
  }
  detailId = id;
  detailPage = 1;
  detailSearch = '';
  detailOrder = 'newest';
  const source = publicUrl(show.url);
  elements.detail.innerHTML = `<a class="pill" href="#">返回目錄</a>
    <header class="detail-head">
      <h2 tabindex="-1">${escape(show.name)}</h2>
      <p class="meta">${languages[show.language]} · ${escape(show.topic)}</p>
      <div class="actions"><a class="pill" href="${escape(source)}" target="_blank" rel="noopener noreferrer">官方節目頁</a>${favoriteButton(show)}</div>
    </header>
    <h3 class="detail-heading">完整單集</h3>
    <div class="archive-controls">
      <label><span class="sr-only">搜尋本節目單集</span>
        <input type="search" data-episode-search placeholder="搜尋單集標題或期號" autocomplete="off">
      </label>
      <label><span class="sr-only">單集排序</span>
        <select data-episode-order><option value="newest">最新優先</option><option value="oldest">最舊優先</option></select>
      </label>
      <span class="meta" data-episode-count></span>
    </div>
    <div class="directory" data-show-episodes></div>
    <div class="archive-more"><button class="pill" type="button" data-load-more>載入更多單集</button></div>`;
  renderShowEpisodes(show);
  elements.detail.querySelector('h2').focus({preventScroll: true});
  window.scrollTo(0, 0);
}

function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  youtubeApi ??= new Promise(resolve => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => resolve(null);
    document.head.append(script);
  });
  return youtubeApi;
}

function saveProgress(session, immediate = false) {
  const seconds = Math.floor(session.player?.getCurrentTime?.() ?? 0);
  const duration = session.player?.getDuration?.() ?? 0;
  if (seconds < 5 || !Number.isFinite(seconds)) return;
  const position = duration > 0 && seconds >= duration - 8 ? 0 : seconds;
  if (position === session.lastSavedPosition) return;
  session.lastSavedPosition = position;
  sync.position(session.episode.id, position, immediate);
}

function renderChapters(session) {
  elements.chapters.innerHTML = (session.episode.chapters || []).map(([seconds, label]) =>
    `<button type="button" class="pill" data-seek="${seconds}">${time(seconds)} ${escape(label)}</button>`
  ).join('');
  elements.chapters.hidden = !elements.chapters.children.length;
}

async function openVideo(episode, trigger) {
  if (!episode?.youtube || elements.watch.open) return;
  focusAfterClose = trigger;
  const show = shows.get(episode.showId);
  const resume = progress.get(episode.id)?.seconds;
  const options = new URLSearchParams({
    autoplay: '1', playsinline: '1', enablejsapi: '1', origin: location.origin
  });
  if (resume) options.set('start', resume);
  const frame = document.createElement('iframe');
  frame.id = 'episode-player';
  frame.title = episode.title;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.allowFullscreen = true;
  frame.src = `https://www.youtube.com/embed/${episode.youtube}?${options}`;
  const session = { episode, player: null, lastSavedPosition: resume ?? 0 };
  const defaultMessage = resume ? `從 ${time(resume)} 繼續觀看` : '由 YouTube 播放';
  session.readyTimeout = setTimeout(() => {
    if (current === session) {
      elements.watchState.textContent = '播放器載入時間較長，也可在原平台觀看。';
    }
  }, 12000);
  current = session;
  elements.watchTitle.textContent = episode.title;
  elements.watchShow.textContent = show.name;
  elements.watchState.textContent = defaultMessage;
  elements.source.href = episodeUrl(episode);
  elements.chapters.hidden = true;
  elements.chapters.replaceChildren();
  elements.screen.replaceChildren(frame);
  elements.watch.showModal();

  const api = await loadYouTube();
  if (current !== session) return;
  if (!api) {
    youtubeApi = undefined;
    clearTimeout(session.readyTimeout);
    elements.watchState.textContent = '如果播放器未載入，可在原平台觀看。';
    return;
  }
  session.player = new api.Player(frame, {
    events: {
      onReady: event => {
        if (current !== session) return;
        clearTimeout(session.readyTimeout);
        elements.watchState.textContent = defaultMessage;
        session.player = event.target;
        renderChapters(session);
        session.timer = setInterval(() => saveProgress(session), 5000);
      },
      onStateChange: event => {
        if (current === session && (event.data === 2 || event.data === 0)) saveProgress(session, true);
      },
      onAutoplayBlocked: () => {
        if (current === session) elements.watchState.textContent = '請按播放器中的播放鍵。';
      },
      onError: ({ data }) => {
        if (current !== session) return;
        clearTimeout(session.readyTimeout);
        clearInterval(session.timer);
        elements.watchState.textContent = data === 101 || data === 150
          ? '發布者限制嵌入播放，請在 YouTube 觀看。'
          : '站內播放器無法載入這部影片，請開啟原平台。';
        elements.chapters.hidden = true;
      }
    }
  });
}

function closeVideo() {
  if (current) {
    saveProgress(current, true);
    sync.flushSoon();
    clearInterval(current.timer);
    clearTimeout(current.readyTimeout);
    current.player?.destroy?.();
    current = null;
  }
  elements.screen.replaceChildren();
  if (elements.detail.hidden) renderRecent();
  if (focusAfterClose?.isConnected) focusAfterClose.focus();
  focusAfterClose = null;
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.watch) openVideo(episodes.get(button.dataset.watch), button);
  if (button.dataset.favorite) {
    const id = button.dataset.favorite;
    sync.favorite(id, !favorites.has(id));
    document.querySelector(`[data-favorite="${id}"]`)?.focus();
  }
  if (button.dataset.view) {
    state.view = button.dataset.view;
    render();
  }
  if (button.dataset.filter) {
    const type = button.parentElement === elements.languages ? 'language' : 'topic';
    state[type] = button.dataset.filter;
    render();
  }
  if (button.dataset.seek) current?.player?.seekTo(Number(button.dataset.seek), true);
  if (button.hasAttribute('data-load-more')) {
    detailPage++;
    renderShowEpisodes(shows.get(detailId));
  }
});
elements.search.addEventListener('input', render);
elements.detail.addEventListener('input', event => {
  if (event.target.matches('[data-episode-search]')) {
    detailSearch = event.target.value;
    detailPage = 1;
    renderShowEpisodes(shows.get(detailId));
  }
});
elements.detail.addEventListener('change', event => {
  if (event.target.matches('[data-episode-order]')) {
    detailOrder = event.target.value;
    detailPage = 1;
    renderShowEpisodes(shows.get(detailId));
  }
});

elements.favorites.addEventListener('click', () => {
  state.favoritesOnly = !state.favoritesOnly;
  if (state.favoritesOnly) state.view = 'shows';
  render();
});
$('#close-watch').addEventListener('click', () => elements.watch.close());
elements.watch.addEventListener('close', closeVideo);
window.addEventListener('hashchange', renderRoute);
window.addEventListener('pagehide', () => { if (current) saveProgress(current); });
document.addEventListener('keydown', event => {
  if (event.key === '/' && !elements.watch.open && !event.target.closest('input, textarea, [contenteditable]') && !elements.search.closest('[hidden]')) {
    event.preventDefault();
    elements.search.focus();
  }
});

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Unable to load ${path}`);
  return response.json();
}

async function boot() {
  try {
    const [catalog, video] = await Promise.all([loadJson('./catalog.json'), loadJson('./episodes.json')]);
    const categories = new Map(Object.entries(video.categories).flatMap(([category, ids]) => ids.map(id => [id, category])));
    shows = new Map(catalog.shows.map(show => [show.id, { ...show, category: categories.get(show.id), episodes: [] }]));
    for (const episode of [...video.episodes].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
      shows.get(episode.showId).episodes.push(episode);
      episodes.set(episode.id, episode);
    }
    makeChips(elements.languages, languages, state.language);
    makeChips(elements.topics, topics, state.topic);
    $('#footer-count').textContent = `${shows.size} 檔節目 · ${episodes.size} 集已選影片`;
    render();
    renderRoute();
  } catch (error) {
    console.error(error);
    elements.summary.textContent = '無法載入目錄。請重新整理頁面。';
  }
}

const sync = setupSync({
  readLocal,
  writeLocal,
  onState({ favorites: nextFavorites, progress: nextProgress, favoritesChanged, progressChanged }) {
    if (favoritesChanged) {
      favorites.clear();
      for (const id of nextFavorites) favorites.add(id);
      if (shows.size) {
        render();
        renderRoute();
      }
    }
    if (progressChanged) {
      progress.clear();
      for (const [id, entry] of Object.entries(nextProgress)) progress.set(id, entry);
      if (elements.detail.hidden && !elements.watch.open) renderRecent();
    }
  }
});

boot();
