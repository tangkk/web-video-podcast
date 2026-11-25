import fs from 'node:fs/promises';

const backfill = process.argv.includes('--backfill');
const dryRun = process.argv.includes('--dry-run');
const selected = process.argv.find(arg => arg.startsWith('--show='))?.slice(7);
const key = process.env.YOUTUBE_API_KEY;
if (!key) throw new Error('YOUTUBE_API_KEY is required. Configure it in GitHub Actions secrets.');
const sources = JSON.parse(await fs.readFile(new URL('./video-sources.json', import.meta.url), 'utf8'));
const catalogFile = new URL('../episodes.json', import.meta.url);
const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'));
const directory = JSON.parse(await fs.readFile(new URL('../catalog.json', import.meta.url), 'utf8'));
const allowedShows = new Set(directory.shows.map(show => show.id));
const target = sources.filter(s => !selected || s.showId === selected);
if (!target.length) throw new Error('No sources selected');
const videoIdRe = /^[A-Za-z0-9_-]{11}$/;
const channelIdRe = /^UC[A-Za-z0-9_-]{22}$/;
for (const source of sources) {
  if (!allowedShows.has(source.showId) || !channelIdRe.test(source.channelId)) {
    throw new Error('Invalid source: ' + source.showId);
  }
}

async function api(resource, params) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + resource);
  for (const [name, value] of Object.entries({...params, key})) {
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  let response;
  for (let retry = 0; retry < 3; retry++) {
    response = await fetch(url, {signal: AbortSignal.timeout(20000)});
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
  }
  const body = await response.text().catch(() => '');
  throw new Error('YouTube API ' + resource + ': HTTP ' + response.status + ': ' + body.slice(0, 200));
}

async function uploadsId(channelId) {
  const result = await api('channels', {part: 'contentDetails', id: channelId, maxResults: 1});
  const id = result.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!id) throw new Error('Uploads playlist unavailable for ' + channelId);
  return id;
}

async function uploads(playlistId) {
  const result = [];
  let pageToken;
  do {
    const page = await api('playlistItems', {part: 'snippet,contentDetails', playlistId, maxResults: 50, pageToken});
    for (const item of page.items ?? []) {
      const video = item.contentDetails?.videoId;
      if (videoIdRe.test(video ?? '')) result.push(video);
    }
    pageToken = page.nextPageToken;
    // Daily discovery scans the newest 100 uploads; historical backfill scans all pages.
  } while (pageToken && (backfill || result.length < 100));
  return [...new Set(result)];
}

function seconds(iso) {
  const m = /^P(?:([0-9]+)D)?T?(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?$/.exec(iso ?? '');
  if (!m) return 0;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 +
    Number(m[3] || 0) * 60 + Number(m[4] || 0);
}

function acceptable(video, source) {
  const title = video.snippet?.title ?? '';
  const duration = seconds(video.contentDetails?.duration);
  if (!title || duration < (source.minMinutes ?? 15) * 60) return false;
  if (video.status?.privacyStatus !== 'public' || video.status?.embeddable !== true) return false;
  if (/^(?:shorts?|clips?|trailer|teaser|preview|highlights?|精[華华]|預告|预告|短片|花絮)(?:\b|[:：｜])/iu.test(title)) return false;
  if (source.titlePattern && !new RegExp(source.titlePattern, 'iu').test(title)) return false;
  if (source.excludePattern && new RegExp(source.excludePattern, 'iu').test(title)) return false;
  return true;
}

async function details(ids) {
  const result = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = await api('videos', {part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(','), maxResults: 50});
    for (const item of batch.items ?? []) result.set(item.id, item);
  }
  return result;
}

const existing = new Map(catalog.episodes.filter(e => e.youtube).map(e => [e.youtube, e]));
const merged = new Map(existing);
let discovered = 0;
let scanned = 0;
let failed = 0;
const sourceResults = [];

for (const source of target) {
  try {
    const ids = await uploads(await uploadsId(source.channelId));
    scanned += ids.length;
    const videos = await details(ids);
    let count = 0;
    for (const id of ids) {
      const video = videos.get(id);
      if (!video || !acceptable(video, source)) continue;
      const old = merged.get(id);
      // Keep manually curated metadata (including chapters), but refresh public title and duration.
      const next = {
        ...(old || {}),
        id: old?.id ?? 'yt-' + id,
        showId: source.showId,
        title: video.snippet.title,
        publishedAt: video.snippet.publishedAt.slice(0, 10),
        youtube: id,
        duration: seconds(video.contentDetails.duration),
        ...(old ? {} : {automatic: true})
      };
      merged.set(id, next);
      count++;
      if (!old) discovered++;
    }
    sourceResults.push({showId: source.showId, scanned: ids.length, eligible: count, status: 'ok'});
    console.log(source.showId + ': ' + count + ' eligible of ' + ids.length + ' uploaded videos');
  } catch (error) {
    failed++;
    sourceResults.push({showId: source.showId, scanned: 0, eligible: 0, status: 'error', error: error.message});
    console.error(source.showId + ': ' + error.message);
  }
}
if (failed === target.length) {
  throw new Error('All ' + failed + ' sources failed; preserving existing catalog.');
}
if (failed > 0) {
  console.warn('PARTIAL SYNC: ' + failed + '/' + target.length +
    ' sources failed. Previous episodes for unavailable sources remain in the catalog.');
}

// Validate ALL catalogued YouTube videos, including old manually curated ones and
// videos not covered by today's limited discovery scan.
const verification = await details([...merged.keys()]);
let dropped = 0;
for (const [id, episode] of merged) {
  const video = verification.get(id);
  if (!video || video.status?.privacyStatus !== 'public' || video.status?.embeddable !== true) {
    merged.delete(id);
    dropped++;
  }
}
const retained = [...merged.values()].filter(e => allowedShows.has(e.showId));
retained.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id));
const result = {...catalog, episodes: retained};
console.log(JSON.stringify({backfill, dryRun, checkedSources: target.length - failed,
  scannedUploads: scanned, newlyFound: discovered, failedSources: failed, excludedUnavailable: dropped, totalEpisodes: retained.length}));
if (!dryRun && backfill) {
  const reportFile = new URL('../scripts/backfill-report.json', import.meta.url);
  const report = {
    generatedAt: new Date().toISOString(),
    sources: sourceResults,
    totals: {sources: target.length, checked: target.length - failed, failed, newlyFound: discovered, episodes: retained.length}
  };
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
}
if (!dryRun) {
  const output = JSON.stringify(result, null, 2) + '\n';
  if (output !== await fs.readFile(catalogFile, 'utf8')) {
    const temp = new URL('../episodes.json.tmp', import.meta.url);
    await fs.writeFile(temp, output);
    await fs.rename(temp, catalogFile);
  }
}
