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
        if (s === 404 || s === 410) fail('links', `${u} returned ${s} (${urlsFromData.get(u)})`);
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

// ---------------------------------------------------------------- back button
async function checkBack() {
  const page = await ctx.newPage();
  let current = 'load';
  page.on('pageerror', e => { if (!IGNORE_ERR.test(e.message)) fail('back', `script error while on "${current}": ${e.message}`); });
  const SKIP = /guide|share|install|^\+|download|sign ?up|subscribe|call |text |email/i;
  const labels = () => page.evaluate(() => [...document.querySelectorAll('.quick-reply')].map(b => b.textContent.trim()));
  const tap = async t => {
    const ok = await page.evaluate(t => {
      const b = [...document.querySelectorAll('.quick-reply')].find(x => x.textContent.trim() === t);
      if (b) { b.click(); return true; } return false;
    }, t);
    await page.waitForTimeout(1300);
    return ok;
  };
  const stack = () => page.evaluate(() => (typeof menuStack !== 'undefined' ? menuStack.slice() : null));
  // A leaf marker or a duplicate of the top entry is not a different screen.
  const norm = s => { const o = []; for (const x of (s || [])) { if (/^leaf-/.test(x)) continue; if (o[o.length - 1] !== x) o.push(x); } return o.join('>'); };
  const fresh = async () => { await page.goto(BASE + APP, { waitUntil: 'domcontentloaded', timeout: 30000 }); await page.waitForTimeout(1200); };

  await fresh();
  const mains = (await labels()).filter(l => !SKIP.test(l) && !/^←/.test(l));
  stats.mainMenu = mains.length;
  let menus = 0, buttons = 0;
  for (const M of mains) {
    current = M;
    await fresh();
    if (!(await tap(M))) continue;
    const sM = await stack();
    if (!sM) { warn('back', 'menuStack not found on the page, Back test skipped'); break; }
    // Back from a main menu button returns to the main menu.
    await page.evaluate(() => goBack()); await page.waitForTimeout(800);
    const sBack = await stack();
    if (norm(sBack) !== 'main') fail('back', `"${M}": Back lands on ${norm(sBack)} instead of main`);
    await fresh(); await tap(M);
    const subs = (await labels()).filter(l => !SKIP.test(l) && !/^←|main menu/i.test(l));
    if (subs.length < 2) continue;
    menus++;
    for (const L of subs) {
      current = `${M} > ${L}`;
      if (norm(await stack()) !== norm(sM)) { await fresh(); await tap(M); }
      if (!(await tap(L))) { await fresh(); await tap(M); if (!(await tap(L))) continue; }
      buttons++;
      await page.evaluate(() => goBack()); await page.waitForTimeout(800);
      const s2 = await stack();
      if (norm(s2) !== norm(sM)) fail('back', `"${M}" > "${L}": one Back lands on ${norm(s2)} instead of ${norm(sM)}`);
    }
  }
  stats.backMenus = menus; stats.backButtons = buttons;
  await page.close();
}

// ---------------------------------------------------------------- run
const steps = [['pages', checkPages], ['data', checkData], ['links', checkLinks], ['api', checkApi], ['back', checkBack]];
for (const [n, fn] of steps) {
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
<p><b>${stats.pages || 0}</b> pages loaded &middot; <b>${stats.links || 0}</b> outbound links checked &middot; <b>${stats.backButtons || 0}</b> menu buttons tested for Back across <b>${stats.backMenus || 0}</b> menus &middot; ${stats.dataFiles || 0} data files</p>
<h3 style="margin:16px 0 4px">Failures (${fails.length})</h3>${li(fails)}
<h3 style="margin:16px 0 4px">Notes (${warns.length})</h3>${li(warns)}
</div>`;
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ name: NAME, base: BASE, date: today, status, seconds: secs, stats, fails, warns }, null, 2));
fs.writeFileSync(path.join(OUT, 'report.html'), html);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${NAME}: ${status}\n\n${fails.length} failures, ${warns.length} notes\n\n` + fails.map(f => `- FAIL ${f.area}: ${f.msg}`).join('\n') + '\n' + warns.map(f => `- note ${f.area}: ${f.msg}`).join('\n') + '\n');
console.log(`\n${NAME}: ${status} (${fails.length} failures, ${warns.length} notes, ${secs}s)`);
process.exit(0);
