import fs from 'node:fs/promises';

const catalogPath = new URL('../episodes.json', import.meta.url);
const [sources, catalog, directory] = await Promise.all([
  readJson(new URL('./video-sources.json', import.meta.url)),
  readJson(catalogPath),
  readJson(new URL('../catalog.json', import.meta.url))
]);
const showIds = new Set(directory.shows.map(show => show.id));
const selected = process.argv.find(arg => arg.startsWith('--show='))?.slice(7);
const active = sources.filter(source => !selected || source.showId === selected);
const channelPattern = /^UC[A-Za-z0-9_-]{22}$/;
const videoPattern = /^[A-Za-z0-9_-]{11}$/;
const scanSince = Date.now() - 45 * 86400000;
const clipPattern = /^(?:\s*[\[【(（])?(?:shorts?|clips?|trailer|teaser|preview|highlights?|精[華华]|預告|预告|短片|花絮)(?:[\s\]】)）：:｜|#]|$)|(?:#shorts|\[(?:trailer|preview|clip)\]|\(\s*(?:trailer|preview|clip)\s*\)|【(?:精華|精华|預告|预告|片段)】)\s*$/i;

if (!active.length) throw new Error('No video sources selected.');
for (const source of sources) {
  if (!showIds.has(source.showId) || !channelPattern.test(source.channelId)) {
    throw new Error(`Invalid source: ${source.showId}`);
  }
}

function readJson(url) {
  return fs.readFile(url, 'utf8').then(JSON.parse);
}

async function request(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'accept-language': 'en-US,en;q=0.8' }
  });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

function decode(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, token) => {
    if (token[0] !== '#') return entities[token.toLowerCase()];
    const hex = token[1].toLowerCase() === 'x';
    const point = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

function atomValue(entry, name) {
  const value = entry.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
  return decode(value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')).trim();
}

function embeddedJson(html, name) {
  const start = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*(?=\\{)`).exec(html);
  if (!start) return null;
  const first = start.index + start[0].length;
  let depth = 0;
  let quoted = false;
  for (let index = first; index < html.length; index++) {
    const char = html[index];
    if (quoted && char === '\\') {
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === '{') {
      depth++;
    } else if (!quoted && char === '}' && --depth === 0) {
      return JSON.parse(html.slice(first, index + 1));
    }
  }
  return null;
}

function durationFromText(label = '') {
  if (!/^\d+(?::[0-5]\d){1,2}$/.test(label)) return 0;
  return label.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function recentUploadDate(metadata) {
  const relative = JSON.stringify(metadata).match(/"content":"(\d+) (minute|hour|day|week)s? ago"/);
  if (!relative) return '';
  const milliseconds = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };
  return new Date(Date.now() - Number(relative[1]) * milliseconds[relative[2]]).toISOString();
}

async function officialUploads(channelId) {
  const html = await (await request(`https://www.youtube.com/channel/${channelId}/videos`)).text();
  const data = embeddedJson(html, 'ytInitialData');
  if (!data?.contents) throw new Error('Public uploads metadata unavailable');
  const candidates = new Map();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    const old = value.videoRenderer;
    const item = value.lockupViewModel;
    const label = JSON.stringify(item?.contentImage ?? {}).match(/"text":"((?:\d+:)?\d+:[0-5]\d)"/)?.[1];
    const video = old?.videoId ?? item?.contentId;
    const title = old?.title?.runs?.map(run => run.text).join('') ??
      item?.metadata?.lockupMetadataViewModel?.title?.content;
    const duration = durationFromText(old?.lengthText?.simpleText ?? label);
    if (videoPattern.test(video ?? '') && title && duration && (old || item.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
      const metadata = old ? { content: old.publishedTimeText?.simpleText } : item.metadata;
      candidates.set(video, { video, title, duration, publishedAt: recentUploadDate(metadata) });
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(data.contents);
  if (!candidates.size) throw new Error('No public finished uploads with a duration');
  return candidates;
}

async function channelCandidates(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const [atom, uploads] = await Promise.all([
    (async () => {
      const xml = await (await request(feedUrl)).text();
      if (!/<feed\b/.test(xml)) throw new Error('Invalid Atom response');
      return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map(([, entry]) => ({
        video: atomValue(entry, 'yt:videoId'),
        title: atomValue(entry, 'title'),
        publishedAt: atomValue(entry, 'published')
      }));
    })().catch(() => null),
    officialUploads(channelId)
  ]);
  return atom ? atom.flatMap(item => {
    const upload = uploads.get(item.video);
    return upload ? [{ ...item, duration: upload.duration }] : [];
  }) : [...uploads.values()];
}

async function videoEpisode(candidate, source) {
  const watch = `https://www.youtube.com/watch?v=${candidate.video}`;
  const published = Date.parse(candidate.publishedAt);
  if (!Number.isFinite(published) || published < scanSince || published > Date.now()) return null;
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.searchParams.set('url', watch);
  endpoint.searchParams.set('format', 'json');
  const embed = await request(endpoint).then(response => response.json()).catch(error => {
    if ([401, 403, 404].includes(error.status)) return null;
    throw error;
  });
  if (embed?.type !== 'video') return null;
  return {
    id: `yt-${candidate.video}`,
    showId: source.showId,
    title: candidate.title,
    publishedAt: new Date(published).toISOString().slice(0, 10),
    youtube: candidate.video,
    duration: candidate.duration,
    automatic: true
  };
}

const existing = new Set(catalog.episodes.map(episode => episode.youtube).filter(Boolean));
const pending = new Map();
let reached = 0;
for (let offset = 0; offset < active.length; offset += 4) {
  const results = await Promise.allSettled(active.slice(offset, offset + 4).map(async source => {
    const entries = await channelCandidates(source.channelId).catch(error => {
      throw new Error(`${source.showId}: ${error.message}`);
    });
    const include = source.titlePattern ? new RegExp(source.titlePattern, 'iu') : null;
    const exclude = source.excludePattern ? new RegExp(source.excludePattern, 'iu') : null;
    const candidates = entries.filter(({video, title, publishedAt, duration}) => videoPattern.test(video) &&
      duration >= (source.minMinutes ?? 15) * 60 && !existing.has(video) && !pending.has(video) && title && !clipPattern.test(title) &&
      (!include || include.test(title)) && (!exclude || !exclude.test(title)) &&
      Date.parse(publishedAt) >= scanSince).slice(0, 8);
    const additions = [];
    let failed = 0;
    for (let index = 0; index < candidates.length && additions.length < 3; index += 2) {
      const checks = await Promise.allSettled(candidates.slice(index, index + 2)
        .map(candidate => videoEpisode(candidate, source)));
      for (const check of checks) {
        if (check.status === 'rejected') failed++;
        else if (check.value && additions.length < 3) additions.push(check.value);
      }
    }
    const usable = failed < candidates.length || !candidates.length;
    console.log(`${source.showId}: ${additions.length} new from ${candidates.length} candidates, ${failed} unavailable checks`);
    return { additions, usable };
  }));
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn(`Source unavailable: ${result.reason.message}`);
      continue;
    }
    if (result.value.usable) reached++;
    for (const item of result.value.additions) {
      if (!pending.has(item.youtube)) pending.set(item.youtube, item);
    }
  }
}
if (!reached) throw new Error('No selected source could be checked. Existing episodes were preserved.');
if (pending.size && !process.argv.includes('--dry-run')) {
  // Keep manually curated entries and a bounded recent history of automatic entries.
  const manual = catalog.episodes.filter(episode => !episode.automatic);
  const counts = new Map();
  const recent = [...pending.values(), ...catalog.episodes.filter(episode => episode.automatic)]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter(episode => {
      const count = (counts.get(episode.showId) ?? 0) + 1;
      counts.set(episode.showId, count);
      return count <= 20;
    });
  const next = `${JSON.stringify({ ...catalog, episodes: [...manual, ...recent] }, null, 2)}\n`;
  const temporary = new URL('../episodes.json.tmp', import.meta.url);
  await fs.writeFile(temporary, next);
  await fs.rename(temporary, catalogPath);
}
console.log(`${reached}/${active.length} sources checked; ${pending.size} new episodes${process.argv.includes('--dry-run') ? ' (dry run)' : ''}.`);
