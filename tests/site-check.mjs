// Nightly site check for Howdy Nash and Howdy Summit County.
// Runs in GitHub Actions against the live site. No keys needed for the checks.
//
// Env:
//   BASE_URL     site root, no trailing slash
//   SITE_NAME    name shown in the report
//   APP_PATH     path of the main app page (default /)
//   SITEMAP      path of the sitemap (default /sitemap.xml)
//   EXTRA_PAGES  comma list of more page paths to load
//   DATA_FILES   comma list of JSON files to validate (default none)
//   OUT_DIR      where to write report.json and report.html (default .)
//   APP_PAGES    comma list of more app pages to walk (hotel pages)
//   TAP_WAIT, MAX_DEPTH, APP_BUDGET_MS, POOL  tuning for the menu walk
//   ONLY         optional comma list of checks to run: pages, data, links, api, back
//
// Checks: pages load with no script errors, data files parse, outbound links in
// data files are not dead, the health endpoint answers, and the Back button
// returns one step from every menu button. Tracking calls are blocked in the
// browser so the test never touches the real usage counts.

import { chromium, request } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const NAME = process.env.SITE_NAME || 'Site';
const APP = process.env.APP_PATH || '/';
const SITEMAP = process.env.SITEMAP || '/sitemap.xml';
const EXTRA = (process.env.EXTRA_PAGES || '').split(',').map(s => s.trim()).filter(Boolean);
const DATA = (process.env.DATA_FILES || '').split(',').map(s => s.trim()).filter(Boolean);
const OUT = process.env.OUT_DIR || '.';
if (!BASE) { console.error('BASE_URL is required'); process.exit(2); }

// The live site is slower than a local copy, so wait longer after each tap.
const TAP_WAIT = Number(process.env.TAP_WAIT || 2200);
const UA = 'Mozilla/5.0 (compatible; HowdyTestBot/1.0)';
const started = Date.now();
const fails = [], warns = [], stats = {};
const fail = (area, msg) => { fails.push({ area, msg }); console.log('FAIL', area, msg); };
const warn = (area, msg) => { warns.push({ area, msg }); console.log('WARN', area, msg); };
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

const api = await request.newContext({ extraHTTPHeaders: { 'User-Agent': UA } });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, userAgent: UA });
// Keep test traffic out of the usage counts and the question log.
await ctx.route(/\/api\/(group|subscribe)(\?|$)/, r => {
  if (r.request().method() === 'POST') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  return r.continue();
});

const isOwn = u => { try { return new URL(u).origin === new URL(BASE).origin; } catch { return false; } };
const IGNORE_ERR = /ERR_BLOCKED|net::ERR_FAILED|favicon|analytics|googletagmanager|doubleclick|facebook|tiktok|clarity|ResizeObserver|Failed to load resource/i;

// ---------------------------------------------------------------- pages
async function pageList() {
  const set = new Set([APP, ...EXTRA.map(p => (p.startsWith('/') ? p : '/' + p))]);
  try {
    const r = await api.get(BASE + SITEMAP, { timeout: 20000 });
    if (r.ok()) {
      const xml = await r.text();
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        try { const u = new URL(m[1].trim()); set.add(u.pathname + u.search); } catch { /* skip */ }
      }
    } else warn('pages', `sitemap returned ${r.status()}`);
  } catch (e) { warn('pages', 'sitemap not reachable: ' + e.message); }
  return [...set];
}

async function checkPages() {
  const pages = await pageList();
  stats.pages = pages.length;
  for (const p of pages) {
    const url = BASE + p;
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('response', r => { if (isOwn(r.url()) && r.status() >= 400 && !/favicon/.test(r.url())) errs.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp || resp.status() >= 400) fail('pages', `${p} returned ${resp ? resp.status() : 'no response'}`);
      else {
        await page.waitForTimeout(700);
        const title = (await page.title()).trim();
        if (!title) warn('pages', `${p} has no title`);
        const hard = errs.filter(e => !/^\d{3} /.test(e) && !IGNORE_ERR.test(e));
        const missing = errs.filter(e => /^\d{3} /.test(e));
        if (hard.length) fail('pages', `${p} script error: ${hard[0]}`);
        if (missing.length) warn('pages', `${p} missing file: ${missing[0]}`);
      }
    } catch (e) { fail('pages', `${p} did not load: ${e.message.split('\n')[0]}`); }
    await page.close();
  }
}

// ---------------------------------------------------------------- data
const urlsFromData = new Map();
function collectUrls(node, file) {
  if (Array.isArray(node)) node.forEach(n => collectUrls(n, file));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^https?:\/\//.test(v) && /url|link|href|website/i.test(k)) { if (!urlsFromData.has(v)) urlsFromData.set(v, file); }
      else collectUrls(v, file);
    }
  }
}

async function checkData() {
  stats.dataFiles = 0;
  for (const f of DATA) {
    try {
      const r = await api.get(`${BASE}/${f.replace(/^\//, '')}`, { timeout: 20000 });
      if (!r.ok()) { fail('data', `${f} returned ${r.status()}`); continue; }
      const j = JSON.parse(await r.text());
      stats.dataFiles++;
      collectUrls(j, f);
      // Dated lists: say so when something already ended but is still listed.
      const list = Array.isArray(j) ? j : (j.events || j.popups || []);
      if (Array.isArray(list)) {
        const ended = list.filter(x => x && x.end && String(x.end) < today && !x.annual);
        if (ended.length) warn('data', `${f}: ${ended.length} entries ended before ${today} (the app hides them): ${ended.slice(0, 3).map(x => x.name).join(', ')}`);
        const soon = list.filter(x => x && x.start && x.end && x.start <= today && x.end >= today);
        stats[f] = `${list.length} entries, ${soon.length} running now`;
      }
    } catch (e) { fail('data', `${f} is not valid: ${e.message}`); }
  }
}

async function checkLinks() {
  const urls = [...urlsFromData.keys()];
  stats.links = urls.length;
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        let r = await api.get(u, { timeout: 15000, maxRedirects: 5, failOnStatusCode: false });
        const s = r.status();
        // 403, 429 and 999 mean the site blocks bots, not that the link is dead.
        const tracker = /tpembars|skimresources|awin1|shareasale|anrdoezrs|jdoqocy|tkqlhce|kqzyfj|dpbolvw|pxf\.io|sjv\.io|impact\.com|prf\.hn/i.test(u);
        if ((s === 404 || s === 410) && tracker) warn('links', `${u} returned ${s}, an affiliate link (${urlsFromData.get(u)})`);
        else if (s === 404 || s === 410) fail('links', `${u} returned ${s} (${urlsFromData.get(u)})`);
        else if (s >= 500) warn('links', `${u} returned ${s}`);
      } catch (e) {
        const m = e.message.split('\n')[0];
        if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|EAI_AGAIN/.test(m)) fail('links', `${u} domain not found (${urlsFromData.get(u)})`);
        else warn('links', `${u} did not answer: ${m}`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ---------------------------------------------------------------- api
async function checkApi() {
  try {
    const r = await api.get(BASE + '/api/health', { timeout: 15000, failOnStatusCode: false });
    if (!r.ok()) { fail('api', `/api/health returned ${r.status()}`); return; }
    const j = await r.json().catch(() => null);
    if (!j) { warn('api', '/api/health did not return JSON'); return; }
    const svc = j.services || {};
    const off = Object.entries(svc).filter(([, v]) => !v).map(([k]) => k);
    if (off.length) warn('api', 'services not configured or down: ' + off.join(', '));
    const bad = j.recentFailures || j.failures || j.upstreamFailures;
    if (bad && Object.keys(bad).length) warn('api', 'recent upstream failures: ' + JSON.stringify(bad).slice(0, 200));
    stats.health = 'ok';
  } catch (e) { fail('api', '/api/health did not answer: ' + e.message.split('\n')[0]); }
}

// ---------------------------------------------------------------- menus, Back button, links
// Walks every menu button, three levels deep. On each screen it records every
// link it shows (checked later by checkLinks) and tests that one Back returns
// to the screen the guest came from. Runs several app pages at once.
const APP_PAGES = [APP, ...(process.env.APP_PAGES || '').split(',').map(x => x.trim()).filter(Boolean).map(x => (x.startsWith('/') ? x : '/' + x))];
const MAX_DEPTH = Number(process.env.MAX_DEPTH || 3);
const APP_BUDGET_MS = Number(process.env.APP_BUDGET_MS || 7 * 60 * 1000);
const POOL = Number(process.env.POOL || 3);
const SKIP = /guide|share|install|^\+|download|sign ?up|subscribe|call |text |email|^←|main menu|more options/i;
const coverage = [];
const OWN_HOSTS = /(^|\.)(howdynash\.com|howdysummitcounty\.com|howdy-nashville\.vercel\.app|howdy-summit\.vercel\.app)$/;

function rememberLink(href, where) {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return;
    let key = href;
    // Our own pages are checked on the address under test, not the public domain.
    if (OWN_HOSTS.test(u.hostname) || u.origin === new URL(BASE).origin) key = BASE + u.pathname + u.search;
    if (!urlsFromData.has(key)) urlsFromData.set(key, where);
  } catch { /* not a link */ }
}

async function crawlApp(appPath) {
  const label = appPath === '/' ? 'home' : appPath.replace(/^\//, '').replace(/\.html$/, '');
  const page = await ctx.newPage();
  let current = 'load';
  const deadline = Date.now() + APP_BUDGET_MS;
  const seen = new Set();
  const cov = { page: label, menus: 0, buttons: 0, links: 0, cut: false };
  page.on('pageerror', e => { if (!IGNORE_ERR.test(e.message)) fail('back', `${label}: script error while on "${current}": ${e.message}`); });
  const labels = () => page.evaluate(() => [...document.querySelectorAll('.quick-reply')].map(b => b.textContent.trim()));
  const stack = () => page.evaluate(() => (typeof menuStack !== 'undefined' ? menuStack.slice() : null));
  // A leaf marker or a duplicate of the top entry is not a different screen.
  const norm = st => { const o = []; for (const x of (st || [])) { if (/^leaf-/.test(x)) continue; if (o[o.length - 1] !== x) o.push(x); } return o.join('>'); };
  const tap = async t => {
    const ok = await page.evaluate(t => {
      const b = [...document.querySelectorAll('.quick-reply')].find(x => x.textContent.trim() === t);
      if (b) { b.click(); return true; } return false;
    }, t);
    await page.waitForTimeout(TAP_WAIT);
    return ok;
  };
  const harvest = async where => {
    const hrefs = await page.evaluate(() => [...(typeof messagesEl !== 'undefined' && messagesEl ? messagesEl : document).querySelectorAll('a[href]')].map(a => a.href));
    hrefs.forEach(h => { const before = urlsFromData.size; rememberLink(h, `${label}: ${where}`); if (urlsFromData.size > before) cov.links++; });
  };
  const fresh = async () => {
    try { await page.evaluate(() => { sessionStorage.clear(); }); } catch {}
    await page.goto(BASE + appPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
  };
  const replay = async path => {
    await fresh();
    for (const t of path) if (!(await tap(t))) return false;
    return true;
  };

  try {
    const queue = [[]];           // paths of menu buttons to open
    while (queue.length) {
      if (Date.now() > deadline) { cov.cut = true; break; }
      const P = queue.shift();
      current = `${label}: ${P.join(' > ') || 'main menu'}`;
      if (!(await replay(P))) continue;
      const sP = await stack();
      if (!sP) { warn('back', `${label}: menuStack not found, Back test skipped`); break; }
      const subs = (await labels()).filter(l => !SKIP.test(l));
      if (P.length) await harvest(P.join(' > '));
      if (P.length && subs.length < 2) continue;   // a result screen, not a menu
      if (P.length) cov.menus++;
      for (const L of subs) {
        if (Date.now() > deadline) { cov.cut = true; break; }
        current = `${label}: ${[...P, L].join(' > ')}`;
        if (norm(await stack()) !== norm(sP) || !(await labels()).includes(L)) { if (!(await replay(P))) break; }
        if (!(await tap(L))) { if (!(await replay(P)) || !(await tap(L))) continue; }
        cov.buttons++;
        await harvest([...P, L].join(' > '));
        const sL = await stack();
        const opensMenu = norm(sL).split('>').length > norm(sP).split('>').length || ((await labels()).filter(x => !SKIP.test(x)).length >= 2 && norm(sL) !== norm(sP));
        await page.evaluate(() => goBack()); await page.waitForTimeout(900);
        const s2 = await stack();
        if (norm(s2) !== norm(sP)) fail('back', `${label}: "${[...P, L].join(' > ')}": one Back lands on ${norm(s2)} instead of ${norm(sP)}`);
        const key = [...P, L].join('>');
        if (opensMenu && P.length + 1 < MAX_DEPTH && !seen.has(key)) { seen.add(key); queue.push([...P, L]); }
      }
      if (!P.length) {
        // Back from a top-level screen returns to the main menu.
      }
    }
  } catch (e) { fail('back', `${label}: crawl crashed: ${e.message.split('\n')[0]}`); }
  await page.close();
  coverage.push(cov);
}

async function checkBack() {
  const queue = [...APP_PAGES];
  async function worker() { while (queue.length) await crawlApp(queue.shift()); }
  await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, worker));
  stats.backMenus = coverage.reduce((a, c) => a + c.menus, 0);
  stats.backButtons = coverage.reduce((a, c) => a + c.buttons, 0);
  stats.backDetail = coverage.sort((a, b) => a.page.localeCompare(b.page)).map(c => `${c.page}: ${c.buttons} buttons in ${c.menus} menus, ${c.links} links${c.cut ? ' (stopped at time limit)' : ''}`).join('<br>');
  const empty = coverage.filter(c => c.buttons === 0);
  if (empty.length) warn('back', 'no menu buttons were tested on: ' + empty.map(c => c.page).join(', '));
}

// ---------------------------------------------------------------- run
const steps = [['pages', checkPages], ['data', checkData], ['back', checkBack], ['links', checkLinks], ['api', checkApi]];
const only = (process.env.ONLY || '').split(',').filter(Boolean); // e.g. ONLY=back for a quick run
for (const [n, fn] of steps) {
  if (only.length && !only.includes(n)) continue;
  try { await fn(); } catch (e) { fail(n, 'check crashed: ' + e.message.split('\n')[0]); }
}
await browser.close(); await api.dispose();

// ---------------------------------------------------------------- report
const secs = Math.round((Date.now() - started) / 1000);
const status = fails.length ? 'FAIL' : warns.length ? 'PASS with notes' : 'PASS';
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const li = a => a.length ? '<ul>' + a.map(x => `<li><b>${esc(x.area)}</b>: ${esc(x.msg)}</li>`).join('') + '</ul>' : '<p>None.</p>';
const color = fails.length ? '#b3261e' : warns.length ? '#b26a00' : '#1b7f3b';
const html = `<div style="font-family:Arial,sans-serif;max-width:640px;line-height:1.45">
<h2 style="margin:0 0 6px">${esc(NAME)} nightly check: <span style="color:${color}">${status}</span></h2>
<p style="color:#555;margin:0 0 14px">${esc(BASE)} &middot; ${today} &middot; ${secs}s</p>
<p><b>${stats.pages || 0}</b> pages loaded &middot; <b>${stats.links || 0}</b> links checked (data files and every menu screen) &middot; <b>${stats.backButtons || 0}</b> menu buttons tested for Back across <b>${stats.backMenus || 0}</b> menus &middot; ${stats.dataFiles || 0} data files</p>
<p style="color:#555;font-size:13px">Menu coverage:<br>${stats.backDetail || 'none'}</p>
<h3 style="margin:16px 0 4px">Failures (${fails.length})</h3>${li(fails)}
<h3 style="margin:16px 0 4px">Notes (${warns.length})</h3>${li(warns)}
</div>`;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ name: NAME, base: BASE, date: today, status, seconds: secs, stats, fails, warns }, null, 2));
fs.writeFileSync(path.join(OUT, 'report.html'), html);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${NAME}: ${status}\n\n${fails.length} failures, ${warns.length} notes\n\n` + fails.map(f => `- FAIL ${f.area}: ${f.msg}`).join('\n') + '\n' + warns.map(f => `- note ${f.area}: ${f.msg}`).join('\n') + '\n');
console.log(`\n${NAME}: ${status} (${fails.length} failures, ${warns.length} notes, ${secs}s)`);
process.exit(0);
