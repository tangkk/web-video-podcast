import assert from 'node:assert/strict';
import fs from 'node:fs';

const catalog = JSON.parse(fs.readFileSync('catalog.json','utf8'));
const data = JSON.parse(fs.readFileSync('episodes.json','utf8'));
const sources = JSON.parse(fs.readFileSync('scripts/video-sources.json','utf8'));
const shows = new Set(catalog.shows.map(s=>s.id));
const ids = new Set();
const videos = new Set();
assert.equal(shows.size,catalog.shows.length,'Duplicate show IDs');
for(const episode of data.episodes) {
  assert(shows.has(episode.showId),'Orphan episode '+episode.id);
  assert(/^[A-Za-z0-9_-]{11}$/.test(episode.youtube || ''),'External or invalid YouTube episode: '+episode.id);
  assert(!ids.has(episode.id),'Duplicate episode ID');
  assert(!videos.has(episode.youtube),'Duplicate video ID');
  ids.add(episode.id); videos.add(episode.youtube);
}
for(const [category,showIds] of Object.entries(data.categories)){
  for(const id of showIds)assert(shows.has(id),'Unknown show '+id+' in '+category);
}
for(const s of sources){
  assert(shows.has(s.showId),'Orphan source '+s.showId);
  assert(/^UC[A-Za-z0-9_-]{22}$/.test(s.channelId),'Invalid channel '+s.showId);
  if(s.titlePattern) new RegExp(s.titlePattern,'iu');
  if(s.excludePattern) new RegExp(s.excludePattern,'iu');
}
console.log('Validated',catalog.shows.length,'shows,',data.episodes.length,'episodes and',sources.length,'sources');
