// Receipts Only autopilot: picks unused finds from the sheet, renders a video
// with maker.html in a hidden browser, uploads it to YouTube as a Short, and
// records what it used in data/state.json.
//
// Env:
//   FORCE=1            post now, ignoring the schedule
//   DRY_RUN=1          make the video but do not upload
//   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN   (GitHub secrets)

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
const WINDOW_MIN = 100; // a late GitHub run still counts for its slot for this long
const env = process.env;

/* ---------------- small helpers ---------------- */
const log = (...a) => console.log('[autopilot]', ...a);
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
export const priceNum = p => { const m = String(p || '').replace(/,/g, '').match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
const isOopbuy = u => /^https?:\/\/([\w-]+\.)*oopbuy\.com(\/|\?|#|$)/i.test(u);

export function recode(u, code) {
  if (!u || !code || !isOopbuy(u)) return u;
  const c = encodeURIComponent(code);
  let hash = ''; const h = u.indexOf('#'); if (h >= 0) { hash = u.slice(h); u = u.slice(0, h); }
  u = u.replace(/([?&])(inviteCode|goodsInviteCode)=[^&]*/gi, (m, sep, k) => sep + k + '=' + c);
  if (!/[?&]inviteCode=/i.test(u)) u += (u.includes('?') ? '&' : '?') + 'inviteCode=' + c;
  return u + hash;
}

export function shorten(name) {
  const s = String(name).replace(/\s+/g, ' ').trim();
  if (s.length <= 34) return s;
  const cut = s.slice(0, 34), sp = cut.lastIndexOf(' ');
  return (sp > 15 ? cut.slice(0, sp) : cut).replace(/[,\-\s]+$/, '');
}

export function toItems(rows, code) {
  const head = (rows[0] || []).map(h => h.trim().toLowerCase());
  const ix = n => head.indexOf(n);
  const c = { name: ix('item'), price: ix('price'), cat: ix('category'), img: ix('image url'), link: ix('affiliate link'), plat: ix('platform'), id: ix('item id'), added: ix('added') };
  if (c.name < 0 || c.link < 0) throw new Error('Sheet is missing the Item or Affiliate link column');
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], g = k => (c[k] >= 0 && r[c[k]] != null ? String(r[c[k]]).trim() : '');
    let link = g('link');
    if (!g('name') || !/^https?:\/\//i.test(link)) continue;
    if (!isOopbuy(link) && /^[\w-]+$/.test(g('plat')) && /^[\w-]+$/.test(g('id')))
      link = `https://oopbuy.com/product/${g('plat')}/${g('id')}?inviteCode=x&goodsInviteCode=x&sourceChannel=41&idp=1`;
    out.push({ key: `${g('plat') || 'item'}-${g('id') || i}`, fullName: g('name'), name: shorten(g('name')), price: g('price'),
               priceNum: priceNum(g('price')), cat: g('cat'), img: /^https?:\/\//i.test(g('img')) ? g('img') : '',
               link: recode(link, code), added: Date.parse(g('added')) || 0, order: i });
  }
  return out;
}

/* ---------------- schedule ---------------- */
export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
// Which slot (if any) is due right now and not posted yet.
export function dueSlot(now, tz, times, posted) {
  const today = localParts(now, tz);
  const yesterday = localParts(new Date(now.getTime() - 86400000), tz);
  const candidates = [];
  for (const t of times) {
    const [h, m] = t.split(':').map(Number), at = h * 60 + m;
    candidates.push({ key: `${today.day} ${t}`, late: today.minutes - at });
    candidates.push({ key: `${yesterday.day} ${t}`, late: today.minutes + 1440 - at }); // slots near midnight
  }
  return candidates.filter(c => c.late >= 0 && c.late < WINDOW_MIN && !posted[c.key]).sort((a, b) => a.late - b.late)[0] || null;
}

/* ---------------- picking finds ---------------- */
const TITLES = [
  (n, under) => `${n} Oopbuy finds under $${under}`,
  (n, under, total) => `Full haul for $${Math.ceil(total)}`,
  n => `${n} finds, one receipt`,
  (n, under) => `Everything here is under $${under}`,
  (n, under, total) => `${n} pieces, $${Math.ceil(total)} total`
];
const niceCeil = n => [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 300, 500].find(s => n <= s) || Math.ceil(n / 100) * 100;

export function pickItems(items, used, count) {
  const withImg = items.filter(i => i.img);
  const pool = withImg.length >= Math.min(3, count) ? withImg : items;
  const fresh = pool.filter(i => !used[i.key]).sort((a, b) => (b.added - a.added) || (b.order - a.order));
  const old = pool.filter(i => used[i.key]).sort((a, b) => used[a.key] - used[b.key]); // least recently used first
  return fresh.concat(old).slice(0, count);
}
export function buildJob(picked, cfg, runIndex) {
  const total = picked.reduce((s, i) => s + (isNaN(i.priceNum) ? 0 : i.priceNum), 0);
  const max = Math.max(0, ...picked.map(i => (isNaN(i.priceNum) ? 0 : i.priceNum)));
  const title = TITLES[runIndex % TITLES.length](picked.length, niceCeil(max || 5), total);
  return {
    title,
    items: picked.map(i => ({ key: i.key, name: i.name, price: i.price, img: i.img })),
    outro: 'That is the whole receipt. Every link is in my bio.',
    site: (cfg.STORE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
    offer: cfg.SIGNUP_OFFER || '',
    voice: cfg.VOICE || '',
    mimePrefs: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']
  };
}
export function description(picked, cfg, title) {
  const code = cfg.INVITE_CODE;
  const lines = [title, ''];
  if (cfg.STORE_URL) lines.push(`Shop every find: ${cfg.STORE_URL}`, '');
  picked.forEach((i, n) => lines.push(`${n + 1}. ${i.name} ${i.price ? '(' + i.price + ')' : ''}`.trim(), i.link));
  lines.push('');
  if (code && !/PASTE/i.test(code)) lines.push(`New to Oopbuy? Sign up: https://oopbuy.com/register?inviteCode=${encodeURIComponent(code)}`);
  lines.push('Affiliate links: I may earn a commission at no extra cost to you. Items are sold and shipped by third-party sellers. Prices may change.', '', cfg.HASHTAGS || '#shorts');
  return lines.join('\n').slice(0, 4900);
}

/* ---------------- rendering ---------------- */
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
function serve(dir) {
  return new Promise(res => {
    const srv = http.createServer(async (req, rsp) => {
      try {
        const p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!p.startsWith(dir)) throw new Error('nope');
        const body = await fs.readFile(p.endsWith('/') ? p + 'index.html' : p);
        rsp.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); rsp.end(body);
      } catch { rsp.writeHead(404); rsp.end(); }
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}
export async function render(job) {
  const srv = await serve(ROOT);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    page.on('console', m => { if (m.type() === 'error') log('page:', m.text()); });
    await page.goto(`http://127.0.0.1:${srv.address().port}/maker.html`);
    await page.waitForFunction(() => typeof window.renderJob === 'function');
    const r = await page.evaluate(async job => {
      const r = await window.renderJob(job, () => {});
      return { b64: r.b64, mime: r.mime, seconds: r.seconds, voice: r.voice, voiceError: r.voiceError };
    }, job);
    return r;
  } finally { await browser.close(); srv.close(); }
}

// Browser recordings have no length info; convert to a normal MP4 so
// YouTube reads the length right and treats it as a Short.
function toMp4(src, dst) {
  return new Promise(res => {
    execFile('ffmpeg', ['-y', '-v', 'error', '-i', src, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', dst], { timeout: 300000 }, err => res(!err));
  });
}

/* ---------------- YouTube ---------------- */
async function accessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: env.YT_REFRESH_TOKEN, grant_type: 'refresh_token' })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('YouTube login failed: ' + (j.error_description || j.error || r.status) + '. Re-do the refresh token step.');
  return j.access_token;
}
export async function upload(bytes, mime, meta) {
  const token = await accessToken();
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': mime, 'x-upload-content-length': String(bytes.length) },
    body: JSON.stringify(meta)
  });
  if (!init.ok) throw new Error('YouTube upload start failed: ' + init.status + ' ' + (await init.text()).slice(0, 500));
  const where = init.headers.get('location');
  const put = await fetch(where, { method: 'PUT', headers: { 'content-type': mime, 'content-length': String(bytes.length) }, body: bytes });
  const j = await put.json().catch(() => ({}));
  if (!put.ok || !j.id) throw new Error('YouTube upload failed: ' + put.status + ' ' + JSON.stringify(j).slice(0, 500));
  return j.id;
}

/* ---------------- main ---------------- */
async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8').catch(() => '{}'));
  state.used ||= {}; state.posted ||= {}; state.history ||= [];
  const force = env.FORCE === '1' || env.FORCE === 'true';
  const dry = env.DRY_RUN === '1' || env.DRY_RUN === 'true' || !env.YT_REFRESH_TOKEN;

  const slot = force ? { key: 'manual ' + new Date().toISOString() } : dueSlot(new Date(), cfg.TIMEZONE, cfg.POST_TIMES, state.posted);
  if (!slot) { log('Nothing due right now.'); return; }
  log('Posting for slot:', slot.key, dry ? '(dry run: no upload)' : '');

  if (/PASTE/i.test(cfg.INVITE_CODE || '')) log('WARNING: INVITE_CODE in config.json is still the placeholder. Links will not earn.');
  const csv = await (await fetch(cfg.CSV_URL, { cache: 'no-store' })).text();
  const items = toItems(parseCsv(csv), /PASTE/i.test(cfg.INVITE_CODE || '') ? '' : cfg.INVITE_CODE);
  if (!items.length) throw new Error('No finds in the sheet.');
  const picked = pickItems(items, state.used, cfg.ITEMS_PER_VIDEO || 5);
  const job = buildJob(picked, cfg, state.history.length);
  log('Title:', job.title, '| items:', picked.map(i => i.name).join(' / '));

  const r = await render(job);
  if (!r.b64) throw new Error('Video came out empty.');
  if (r.voiceError) log('Voice failed, video has no voice:', r.voiceError);
  let bytes = Buffer.from(r.b64, 'base64'), mime = r.mime;
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
  const raw = path.join(OUT, 'raw.' + (mime === 'video/mp4' ? 'mp4' : 'webm'));
  await fs.writeFile(raw, bytes);
  const mp4 = path.join(OUT, 'video.mp4');
  if (await toMp4(raw, mp4)) { bytes = await fs.readFile(mp4); mime = 'video/mp4'; await fs.rm(raw); }
  else log('ffmpeg not available, uploading the browser recording as-is.');
  log(`Video: ${(bytes.length / 1e6).toFixed(1)} MB, ${r.seconds.toFixed(1)}s, ${mime}, voice: ${r.voice}`);

  const title = (job.title + ' #shorts').slice(0, 100);
  let videoId = null;
  if (!dry) {
    videoId = await upload(bytes, mime, {
      snippet: { title, description: description(picked, cfg, job.title), categoryId: '26', tags: ['oopbuy', 'finds', 'haul', 'fashion'] },
      status: { privacyStatus: cfg.PRIVACY || 'public', selfDeclaredMadeForKids: false }
    });
    log('Posted: https://youtube.com/shorts/' + videoId);
  }

  if (!dry) {
    const now = Date.now();
    picked.forEach(i => { state.used[i.key] = now; });
  }
  if (!dry) state.posted[slot.key] = videoId;
  state.history.push({ at: new Date().toISOString(), slot: slot.key, title: job.title, videoId, items: picked.map(i => i.key), dry });
  state.history = state.history.slice(-200);
  const keep = Object.keys(state.posted).sort().slice(-60); state.posted = Object.fromEntries(keep.map(k => [k, state.posted[k]]));
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('[autopilot] FAILED:', e.message || e); process.exit(1); });
}
