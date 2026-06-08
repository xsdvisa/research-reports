// build.mjs — zero-dependency static site generator for the 投研中心 site.
//
// What it does:
//   1. Scans reports/<category>/**/*.html and reads each report's metadata
//      (from <title>, <html lang>, optional <meta name="report:*"> tags, and
//      optional overrides in reports.config.json).
//   2. Groups bilingual/multi-language reports that share a "group" key into a
//      single card, and remembers each language's title/summary/file.
//   3. Renders a self-contained, BILINGUAL dist/index.html (CN/EN toggle in the
//      top-right; all UI text switches, no mixing) plus robots.txt.
//   4. Copies reports/ into dist/reports/, injecting a matching top-right nav
//      bar into each report HTML (← home + switch to the other language). The
//      SOURCE report files are never modified — only the dist copies.
//
// To add a report: drop an .html into reports/<category>/ and (optionally) add a
// metadata entry to reports.config.json. Then `node build.mjs`. On Vercel this
// runs automatically on every push. See README.md.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = process.cwd();
const REPORTS_DIR = join(ROOT, 'reports');
const DIST = join(ROOT, 'dist');
const CONFIG_FILE = join(ROOT, 'reports.config.json');

/* ----------------------------------------------------------------------------
 * Site-wide settings (edit these freely)
 * ------------------------------------------------------------------------- */
const SITE = {
  title: '投研中心',
  titleEn: 'Investment Research',
  taglineZh: '美股 · 加密 · 未来学 · 宏观 —— 多模型交叉验证的深度推演与数据分析。',
  taglineEn: 'Equities · Crypto · Futurology · Macro — deep, data-driven projections with multi-model cross-validation.',
  email: 'stone233@icloud.com',
  // Used for absolute og:url when available — Vercel sets this at build time.
  baseUrl: (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.SITE_URL || '').replace(/^https?:\/\//, ''),
};

/* ----------------------------------------------------------------------------
 * Category display config. A folder under reports/ whose name matches a key
 * here gets this label/emoji/accent. Unknown folders still work with defaults.
 * The order here is the order categories appear in the filter bar.
 * ------------------------------------------------------------------------- */
const CATEGORIES = {
  'crypto':    { zh: '加密',   en: 'Crypto',     emoji: '₿',  accent: '#ff9f0a' },
  'us-stocks': { zh: '美股',   en: 'US Stocks',  emoji: '📈', accent: '#34c759' },
  'futurology':{ zh: '未来学', en: 'Futurology', emoji: '🛰️', accent: '#bf5af2' },
  'macro':     { zh: '宏观',   en: 'Macro',      emoji: '🌐', accent: '#0a84ff' },
};
const DEFAULT_CATEGORY = { emoji: '📄', accent: '#6b7280' };

function categoryInfo(slug) {
  const c = CATEGORIES[slug];
  if (c) return c;
  return { zh: slug, en: slug, ...DEFAULT_CATEGORY };
}

/* ----------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */
const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Bilingual inline span pair — JS/CSS shows the active language only.
const bi = (zh, en) => `<span class="i18n-zh">${esc(zh)}</span><span class="i18n-en">${esc(en || zh)}</span>`;

function decodeEntities(s = '') {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function extractTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()) : '';
}
function extractLang(html) {
  const m = html.match(/<html[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].trim() : '';
}
function extractReportMeta(html) {
  const meta = {};
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = (tag.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!name || !/^report:/i.test(name)) continue;
    const content = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    meta[name.slice('report:'.length).toLowerCase()] = decodeEntities(content.trim());
  }
  return meta;
}
function extractHeroSub(html) {
  const m = html.match(/<p[^>]*class=["'][^"']*\bsub\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
  if (!m) return '';
  return decodeEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

const langKey = (lang) => {
  const l = (lang || '').toLowerCase();
  if (l.startsWith('zh')) return 'zh';
  if (l.startsWith('en')) return 'en';
  return l || 'xx';
};
function langLabel(lang) {
  const k = langKey(lang);
  if (k === 'zh') return { label: '中文', rank: 0 };
  if (k === 'en') return { label: 'EN', rank: 1 };
  if (k === 'ja') return { label: '日本語', rank: 2 };
  return { label: (lang || '阅读').toUpperCase(), rank: 3 };
}
const shortLang = (lang) => {
  const k = langKey(lang);
  if (k === 'zh') return '中';
  if (k === 'en') return 'EN';
  return (lang || '').slice(0, 2).toUpperCase();
};
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

// Relative href from one dist path to another (so links work on Vercel AND file://)
function relHref(fromDistRel, toDistRel) {
  const fromDir = fromDistRel.split('/').slice(0, -1);
  const to = toDistRel.split('/');
  let i = 0;
  while (i < fromDir.length && i < to.length - 1 && fromDir[i] === to[i]) i++;
  const parts = [];
  for (let k = 0; k < fromDir.length - i; k++) parts.push('..');
  for (let k = i; k < to.length; k++) parts.push(encodeURIComponent(to[k]));
  return parts.join('/') || '.';
}
function homeHref(fromDistRel) {
  const depth = fromDistRel.split('/').length - 1;
  let p = '';
  for (let k = 0; k < depth; k++) p += '../';
  return p + 'index.html';
}

/* ----------------------------------------------------------------------------
 * Collect reports
 * ------------------------------------------------------------------------- */
const config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};
const files = walk(REPORTS_DIR).filter((f) => /\.html?$/i.test(f));

const reports = files.map((abs) => {
  const rel = abs.slice(REPORTS_DIR.length + 1).split(/[/\\]/).join('/');
  const folder = rel.split('/')[0];
  const html = readFileSync(abs, 'utf8');
  const cfg = config[rel] || {};
  const meta = extractReportMeta(html);
  const category = cfg.category || meta.category || folder;
  const info = categoryInfo(category);
  return {
    rel,
    href: 'reports/' + rel.split('/').map(encodeURIComponent).join('/'),
    title: cfg.title || meta.title || extractTitle(html) || rel,
    lang: cfg.lang || meta.lang || extractLang(html) || '',
    category,
    summary: cfg.summary || meta.summary || extractHeroSub(html) || '',
    date: cfg.date || meta.date || '',
    emoji: cfg.emoji || meta.emoji || info.emoji,
    accent: cfg.accent || meta.accent || info.accent,
    featured: truthy(cfg.featured ?? meta.featured),
    group: cfg.group || meta.group || ('__' + rel),
    primary: truthy(cfg.primary ?? meta.primary),
    groupTitle: cfg.grouptitle || cfg.groupTitle || meta.grouptitle || '',
  };
});
const reportByRel = new Map(reports.map((r) => [r.rel, r]));

/* ----------------------------------------------------------------------------
 * Group multi-language reports into cards (language-keyed)
 * ------------------------------------------------------------------------- */
const groups = new Map();
for (const r of reports) {
  if (!groups.has(r.group)) groups.set(r.group, []);
  groups.get(r.group).push(r);
}

const cards = [];
for (const members of groups.values()) {
  const primary =
    members.find((m) => m.primary) ||
    members.find((m) => langKey(m.lang) === 'zh') ||
    members[0];

  const byLang = {};
  for (const m of members) {
    const k = langKey(m.lang);
    if (!byLang[k]) byLang[k] = { title: m.title, summary: m.summary, href: m.href };
  }
  const langs = members
    .map((m) => ({ ...langLabel(m.lang), href: m.href }))
    .sort((a, b) => a.rank - b.rank);
  const seen = {};
  for (const l of langs) {
    if (seen[l.label]) l.label = l.label + ' ' + (++seen[l.label]);
    else seen[l.label] = 1;
  }

  const zh = byLang.zh || null;
  const en = byLang.en || null;
  const fallback = zh || en || { title: primary.title, summary: primary.summary };
  cards.push({
    category: primary.category,
    date: members.map((m) => m.date).filter(Boolean).sort().pop() || '',
    emoji: primary.emoji,
    accent: primary.accent,
    featured: members.some((m) => m.featured),
    titleZh: (zh && zh.title) || (primary.groupTitle || fallback.title),
    titleEn: (en && en.title) || fallback.title,
    summaryZh: (zh && zh.summary) || fallback.summary,
    summaryEn: (en && en.summary) || fallback.summary,
    langs,
  });
}

cards.sort((a, b) => {
  if (a.featured !== b.featured) return a.featured ? -1 : 1;
  const da = a.date || '', db = b.date || '';
  if (da !== db) return da < db ? 1 : -1;
  return a.titleZh.localeCompare(b.titleZh, 'zh');
});

const counts = {};
for (const c of cards) counts[c.category] = (counts[c.category] || 0) + 1;
const catOrder = [...Object.keys(CATEGORIES)];
for (const c of cards) if (!catOrder.includes(c.category)) catOrder.push(c.category);
const lastUpdated = cards.map((c) => c.date).filter(Boolean).sort().pop() || '';

/* ----------------------------------------------------------------------------
 * Inject the top-right nav bar into each report (dist copy only)
 * ------------------------------------------------------------------------- */
const REPORT_NAV_CSS =
  '.rhnav{position:fixed;top:14px;right:14px;z-index:99999;display:flex;gap:8px;align-items:center;' +
  'font-family:-apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,sans-serif}' +
  '.rhnav a{display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-size:13px;font-weight:700;' +
  'padding:8px 13px;border-radius:999px;color:#1c1c2e;background:rgba(255,255,255,.72);' +
  'border:1px solid rgba(255,255,255,.9);box-shadow:0 4px 16px rgba(60,70,110,.12);' +
  'backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);transition:.16s}' +
  '.rhnav a:hover{transform:translateY(-1px);box-shadow:0 8px 22px rgba(60,70,110,.18);color:#ff6b35}' +
  '.rhnav .rhlang{min-width:34px;justify-content:center}@media print{.rhnav{display:none}}';

function injectReportNav(html, rel) {
  const r = reportByRel.get(rel);
  const lang = r ? r.lang : extractLang(html);
  const isEn = langKey(lang) === 'en';
  const fromDR = 'reports/' + rel;
  const members = r ? groups.get(r.group) || [] : [];
  const sibLinks = members
    .filter((m) => m.rel !== rel)
    .map((m) => `<a class="rhlang" href="${esc(relHref(fromDR, 'reports/' + m.rel))}">${esc(shortLang(m.lang))}</a>`)
    .join('');
  const widget =
    `<div class="rhnav"><a class="rhhome" href="${esc(homeHref(fromDR))}">← ${esc(isEn ? SITE.titleEn : SITE.title)}</a>${sibLinks}</div>`;
  const inject =
    `<style>${REPORT_NAV_CSS}</style>${widget}` +
    `<script>try{localStorage.setItem('rh-lang','${isEn ? 'en' : 'zh'}')}catch(e){}</script>`;
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, (m, p1) => p1 + inject);
  return inject + html;
}

/* ----------------------------------------------------------------------------
 * Render homepage
 * ------------------------------------------------------------------------- */
const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#ff6b35"/><stop offset=".5" stop-color="#ff9f0a"/><stop offset="1" stop-color="#0a84ff"/>' +
      '</linearGradient></defs>' +
      '<rect width="64" height="64" rx="15" fill="url(#g)"/>' +
      '<rect x="16" y="34" width="7" height="14" rx="2" fill="#fff" opacity=".95"/>' +
      '<rect x="28.5" y="26" width="7" height="22" rx="2" fill="#fff" opacity=".95"/>' +
      '<rect x="41" y="18" width="7" height="30" rx="2" fill="#fff" opacity=".95"/>' +
      '</svg>'
  );

const CSS = `
:root{
  --bg:#f2f4f8;--card:rgba(255,255,255,.62);--cardBorder:rgba(255,255,255,.85);
  --gold:#ff9f0a;--orange:#ff6b35;--blue:#0a84ff;--purple:#bf5af2;
  --txt:#1c1c2e;--muted:#6b7280;--line:rgba(120,120,140,.14);
}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:-apple-system,"SF Pro Display","PingFang SC","Microsoft YaHei",Segoe UI,sans-serif;
  color:var(--txt);line-height:1.7;-webkit-font-smoothing:antialiased;min-height:100vh;
  background:
    radial-gradient(1100px 760px at 8% -8%, #ffe7c2 0%, transparent 55%),
    radial-gradient(1000px 720px at 95% 2%, #ffd9e6 0%, transparent 52%),
    radial-gradient(1200px 900px at 50% 110%, #cfe4ff 0%, transparent 55%),
    linear-gradient(160deg,#f6f8fc 0%,#eef1f7 100%);
  background-attachment:fixed;}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px 90px}
a{text-decoration:none;color:inherit}

/* i18n toggling */
.i18n-en{display:none}
html[lang="en"] .i18n-zh{display:none}
html[lang="en"] .i18n-en{display:inline}

/* LANGUAGE SWITCH (top-right, fixed) */
.langsw{position:fixed;top:16px;right:16px;z-index:9999;display:flex;gap:2px;padding:4px;border-radius:999px;
  background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.9);box-shadow:0 4px 16px rgba(60,70,110,.12);
  backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%)}
.langsw button{border:0;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;
  color:#6b7280;padding:6px 14px;border-radius:999px;transition:.16s}
.langsw button.active{color:#fff;background:linear-gradient(120deg,#ff6b35,#ff9f0a 60%,#bf5af2);
  box-shadow:0 4px 12px rgba(255,107,53,.3)}

/* HERO */
.hero{padding:78px 0 30px;text-align:center;position:relative}
.badge{display:inline-block;font-size:13px;letter-spacing:1.5px;color:var(--orange);
  border:1px solid rgba(255,159,10,.3);border-radius:999px;padding:7px 18px;margin-bottom:26px;
  background:rgba(255,255,255,.6);backdrop-filter:blur(20px) saturate(180%);
  -webkit-backdrop-filter:blur(20px) saturate(180%);box-shadow:0 4px 16px rgba(255,159,10,.12);
  text-transform:uppercase;font-weight:600}
.hero h1{font-size:56px;font-weight:800;line-height:1.15;letter-spacing:-1px;margin-bottom:16px;
  background:linear-gradient(115deg,#ff6b35 0%,#ff9f0a 38%,#bf5af2 78%,#0a84ff 100%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.hero p.tag{color:var(--muted);font-size:17px;max-width:700px;margin:0 auto}
.meta{margin-top:26px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;font-size:13px;color:#52607a}
.meta span{background:rgba(255,255,255,.62);border:1px solid var(--cardBorder);padding:7px 15px;border-radius:12px;
  backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);
  box-shadow:0 2px 10px rgba(60,70,110,.06);font-weight:500}

/* FILTER PILLS */
.filters{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin:38px 0 34px;position:sticky;top:0;z-index:5;padding:14px 0}
.pill{cursor:pointer;border:1px solid var(--cardBorder);background:rgba(255,255,255,.62);
  backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);
  padding:9px 17px;border-radius:999px;font-size:14px;font-weight:600;color:#3b4763;
  box-shadow:0 2px 10px rgba(60,70,110,.06);transition:.18s;display:inline-flex;align-items:center;gap:7px}
.pill:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(60,70,110,.12)}
.pill i{font-style:normal;font-size:12px;font-weight:700;color:#8a93a6;background:rgba(120,130,160,.12);
  padding:1px 8px;border-radius:999px;min-width:20px;text-align:center}
.pill.active{color:#fff;border-color:transparent;background:linear-gradient(120deg,#ff6b35,#ff9f0a 55%,#bf5af2);
  box-shadow:0 8px 22px rgba(255,107,53,.28)}
.pill.active i{color:#fff;background:rgba(255,255,255,.22)}

/* GRID */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:22px}
.card{position:relative;display:flex;flex-direction:column;border-radius:24px;padding:26px 26px 22px;
  background:var(--card);border:1px solid var(--cardBorder);overflow:hidden;
  backdrop-filter:blur(30px) saturate(180%);-webkit-backdrop-filter:blur(30px) saturate(180%);
  box-shadow:0 8px 32px rgba(60,70,110,.10), inset 0 1px 0 rgba(255,255,255,.7);
  transition:transform .2s, box-shadow .2s, border-color .2s}
.card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--accent);opacity:.85}
.card:hover{transform:translateY(-5px);border-color:var(--accent);
  box-shadow:0 18px 46px rgba(60,70,110,.16), inset 0 1px 0 rgba(255,255,255,.8)}
.card-top{display:flex;align-items:center;gap:11px;margin-bottom:16px;flex-wrap:wrap}
.cemoji{font-size:22px;width:42px;height:42px;display:grid;place-items:center;border-radius:13px;
  background:color-mix(in srgb, var(--accent) 16%, white);border:1px solid color-mix(in srgb, var(--accent) 28%, white)}
.cpill{font-size:12px;font-weight:700;color:var(--accent);background:color-mix(in srgb, var(--accent) 12%, white);
  border:1px solid color-mix(in srgb, var(--accent) 24%, white);padding:4px 11px;border-radius:999px;letter-spacing:.3px}
.star{margin-left:auto;font-size:11px;font-weight:700;color:#a8730b;background:linear-gradient(120deg,#fff1cf,#ffe3a8);
  border:1px solid #ffd98a;padding:4px 10px;border-radius:999px;letter-spacing:.5px}
.card h3{font-size:20px;font-weight:750;line-height:1.34;letter-spacing:-.2px;margin-bottom:10px}
.csum{font-size:14.5px;color:#5a6175;flex:1;margin-bottom:18px;
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.cfoot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding-top:15px;border-top:1px solid var(--line)}
.cdate{font-size:12.5px;color:#9aa3b5;font-weight:500}
.clangs{display:flex;gap:8px;flex-wrap:wrap}
.clink{font-size:13.5px;font-weight:700;color:var(--accent);padding:7px 14px;border-radius:11px;
  background:color-mix(in srgb, var(--accent) 10%, white);border:1px solid color-mix(in srgb, var(--accent) 22%, white);transition:.16s}
.clink:hover{background:var(--accent);color:#fff}

/* EMPTY STATE */
.empty{text-align:center;color:#9aa3b5;font-size:15px;padding:60px 20px;display:none}
.empty .em{font-size:34px;display:block;margin-bottom:10px}

/* FOOTER */
footer{margin-top:64px;text-align:center;color:#9aa3b5;font-size:13px;line-height:2}
footer a{color:#7a8398;font-weight:600;border-bottom:1px dashed rgba(120,130,160,.4)}
footer a:hover{color:var(--orange)}
.dot{margin:0 8px;opacity:.5}

@media(max-width:640px){
  .hero{padding:62px 0 22px}
  .hero h1{font-size:40px}
  .grid{grid-template-columns:1fr}
  .langsw{top:12px;right:12px}
}
`;

const SCRIPT = `
(function(){
  var KEY='rh-lang', TZH=${JSON.stringify(SITE.title)}, TEN=${JSON.stringify(SITE.titleEn)};
  var sw=document.getElementById('langsw');
  function setLang(l){
    l=(l==='en')?'en':'zh';
    document.documentElement.lang=(l==='en')?'en':'zh-CN';
    document.title=(l==='en')?TEN:TZH;
    try{localStorage.setItem(KEY,l)}catch(e){}
    if(sw){var bs=sw.querySelectorAll('button');for(var i=0;i<bs.length;i++){bs[i].classList.toggle('active',bs[i].getAttribute('data-set')===l);}}
  }
  var saved='zh'; try{ if(localStorage.getItem(KEY)==='en') saved='en'; }catch(e){}
  setLang(saved);
  if(sw){var b=sw.querySelectorAll('button');for(var i=0;i<b.length;i++){(function(x){x.addEventListener('click',function(){setLang(x.getAttribute('data-set'));});})(b[i]);}}

  var pills=document.querySelectorAll('[data-filter]');
  var cards=document.querySelectorAll('.card');
  var empty=document.getElementById('empty');
  function apply(cat){
    var n=0;
    for(var i=0;i<cards.length;i++){var c=cards[i];var show=(cat==='all'||c.getAttribute('data-category')===cat);c.style.display=show?'':'none';if(show)n++;}
    for(var j=0;j<pills.length;j++){pills[j].classList.toggle('active',pills[j].getAttribute('data-filter')===cat);}
    if(empty)empty.style.display=n?'none':'block';
  }
  function fromHash(){var h=(location.hash||'').replace('#','');for(var i=0;i<pills.length;i++){if(pills[i].getAttribute('data-filter')===h)return h;}return 'all';}
  for(var k=0;k<pills.length;k++){(function(p){p.addEventListener('click',function(){var cat=p.getAttribute('data-filter');if(cat==='all'){history.replaceState(null,'',location.pathname);}else{location.hash=cat;}apply(cat);});})(pills[k]);}
  window.addEventListener('hashchange',function(){apply(fromHash());});
  apply(fromHash());
})();
`;

function renderCard(c) {
  const info = categoryInfo(c.category);
  const links = c.langs.map((l) => `<a class="clink" href="${esc(l.href)}">${esc(l.label)} →</a>`).join('');
  return `      <article class="card" data-category="${esc(c.category)}" style="--accent:${esc(c.accent)}">
        <div class="card-top">
          <span class="cemoji">${esc(c.emoji)}</span>
          <span class="cpill">${bi(info.zh, info.en)}</span>
          ${c.featured ? `<span class="star">${bi('★ 精选', '★ Featured')}</span>` : ''}
        </div>
        <h3>${bi(c.titleZh, c.titleEn)}</h3>
        <p class="csum">${bi(c.summaryZh, c.summaryEn)}</p>
        <div class="cfoot">
          <span class="cdate">${c.date ? esc(c.date) : ''}</span>
          <div class="clangs">${links}</div>
        </div>
      </article>`;
}

const pillsHtml = [
  `<button class="pill active" data-filter="all">${bi('全部', 'All')} <i>${cards.length}</i></button>`,
  ...catOrder.map((slug) => {
    const info = categoryInfo(slug);
    return `<button class="pill" data-filter="${esc(slug)}">${esc(info.emoji)} ${bi(info.zh, info.en)} <i>${counts[slug] || 0}</i></button>`;
  }),
].join('\n    ');

const cardsHtml = cards.map(renderCard).join('\n');
const ogUrl = SITE.baseUrl ? `https://${SITE.baseUrl}/` : '';
const desc = `${SITE.taglineZh} ${SITE.taglineEn}`;

const page = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(SITE.title)} · ${esc(SITE.titleEn)}</title>
<script>try{if(localStorage.getItem('rh-lang')==='en')document.documentElement.lang='en';}catch(e){}</script>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(SITE.title)} · ${esc(SITE.titleEn)}">
<meta property="og:description" content="${esc(desc)}">
${ogUrl ? `<meta property="og:url" content="${esc(ogUrl)}">` : ''}
<meta name="twitter:card" content="summary">
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<div class="langsw" id="langsw" role="group" aria-label="Language">
  <button type="button" data-set="zh">中</button>
  <button type="button" data-set="en">EN</button>
</div>
<div class="wrap">
  <header class="hero">
    <span class="badge">${bi('深度投研', 'RESEARCH')}</span>
    <h1>${bi(SITE.title, SITE.titleEn)}</h1>
    <p class="tag">${bi(SITE.taglineZh, SITE.taglineEn)}</p>
    <div class="meta">
      <span>${bi('共 ' + cards.length + ' 篇报告', cards.length + ' reports')}</span>
      ${lastUpdated ? `<span>${bi('最近更新 ' + lastUpdated, 'Updated ' + lastUpdated)}</span>` : ''}
      <span>${bi('持续更新中', 'Continuously updated')}</span>
    </div>
  </header>

  <nav class="filters">
    ${pillsHtml}
  </nav>

  <main class="grid" id="grid">
${cardsHtml}
  </main>

  <div class="empty" id="empty">
    <span class="em">🗂️</span>
    ${bi('该分类下还没有报告，敬请期待。', 'No reports in this category yet — coming soon.')}
  </div>

  <footer>
    ${bi(SITE.title, SITE.titleEn)}<br>
    ${bi('联系', 'Contact')}：<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>
    <span class="dot">·</span>${bi('持续更新中', 'Continuously updated')}
  </footer>
</div>
<script>${SCRIPT}</script>
</body>
</html>
`;

/* ----------------------------------------------------------------------------
 * Write dist
 * ------------------------------------------------------------------------- */
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
for (const abs of walk(REPORTS_DIR)) {
  const rel = abs.slice(REPORTS_DIR.length + 1).split(/[/\\]/).join('/');
  if (rel.endsWith('.gitkeep')) continue;
  const target = join(DIST, 'reports', rel);
  mkdirSync(dirname(target), { recursive: true });
  if (/\.html?$/i.test(abs)) writeFileSync(target, injectReportNav(readFileSync(abs, 'utf8'), rel));
  else copyFileSync(abs, target);
}
writeFileSync(join(DIST, 'index.html'), page);
writeFileSync(join(DIST, 'robots.txt'), 'User-agent: *\nAllow: /\n');

/* ----------------------------------------------------------------------------
 * Log summary
 * ------------------------------------------------------------------------- */
console.log(`\n✓ Built dist/  —  ${cards.length} card(s) from ${reports.length} report file(s)`);
for (const slug of catOrder) {
  const info = categoryInfo(slug);
  console.log(`   • ${info.zh} ${info.en}: ${counts[slug] || 0}`);
}
if (!SITE.baseUrl) console.log('   (set SITE_URL env to emit absolute og:url — Vercel sets it automatically)');
console.log('');
