# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A public, zero-dependency static site that publishes standalone HTML research reports (美股 / 加密 / 未来学 / 宏观). Each report is a self-contained `.html` file. A single build script generates a **bilingual (CN/EN)** landing page that indexes them. Deployed via **GitHub (`xsdvisa/research-reports`) → Vercel**: every push triggers a Vercel rebuild that runs the build and serves `dist/`.

## Commands

```bash
node build.mjs        # build: scan reports/ → generate dist/ (index.html, robots.txt, reports)
npm run build         # same thing
npm run preview       # build, then serve dist/ on :8080 (python3 http.server, falls back to npx serve)
open dist/index.html  # the homepage is pre-rendered static — opens directly via file://, no server needed
```

There are no tests, no linter, and no dependencies to install. `build.mjs` is pure Node ESM (no `npm install`); developed on Node 25.

## Architecture

The entire site generator is **`build.mjs`** (one file). Pipeline:

1. **Discover** — recursively walk `reports/` for `*.html`. The first path segment is the report's category slug (`reports/crypto/x.html` → `crypto`).
2. **Extract metadata** per file from three sources, in increasing precedence:
   - derived: `<title>`, `<html lang>`, and the hero subtitle (`<p class="sub">`) as a fallback summary;
   - `<meta name="report:KEY" content="...">` tags inside the report (keys: `category, date, summary, emoji, accent, featured, group, primary`);
   - an entry in **`reports.config.json`** keyed by path-relative-to-`reports/` (e.g. `"crypto/比特币….html"`). **Config wins over meta wins over derived.**
3. **Group** — reports sharing a `group` value merge into one card. Each language's title/summary/file is kept (keyed by `<html lang>`: `zh*`, `en*`) so the card can render either language; `primary: true` (or first `zh`) supplies category/emoji/date + the fallback title. Each member also yields a language button (中文/EN). A report with no `group` is its own single card.
4. **Render** — produce `dist/index.html`: a **bilingual** glassmorphism landing page (hero + sticky category filter pills + card grid). A fixed top-right CN/EN switch sets `document.documentElement.lang`; CSS (`.i18n-zh`/`.i18n-en`) then shows only the active language. Every piece of UI text and every card's title/summary is emitted in both languages via the `bi(zh, en)` helper. The choice persists in `localStorage['rh-lang']` (an inline `<head>` script applies it pre-paint to avoid a flash). Cards sort featured-first, then `date` desc (string `YYYY-MM-DD`; undated last), then title.
5. **Emit** — wipe and rewrite `dist/`: write `index.html` + `robots.txt`, and copy `reports/` into `dist/reports/` — but each report `.html` is passed through `injectReportNav()`, which inserts a fixed top-right bar (← home + a button to each sibling-language version, using relative hrefs so it works on Vercel and `file://`) right after `<body>`. **Source report files are never modified — only the dist copies.** Non-HTML files are copied verbatim; `.gitkeep` is skipped.

Two config blocks at the top of `build.mjs` are the main tuning knobs:
- `SITE` — `title`/`titleEn`, `taglineZh`/`taglineEn`, `email` (shown in footer).
- `CATEGORIES` — slug → `{ zh, en, emoji, accent }`. The key order here is the filter-bar order. A `reports/` folder whose name isn't in `CATEGORIES` still works (falls back to slug name + neutral styling), and configured categories with zero reports still render a pill (with a "coming soon" empty state). So **adding a category = create `reports/<slug>/` + optionally add a `CATEGORIES` entry.**

The homepage's inline CSS deliberately mirrors the reports' own style (same `--gold/--orange/--blue/--purple` palette, radial-gradient background, glass cards, gradient hero text) so the index and the reports feel like one site. The bar injected into each report (`REPORT_NAV_CSS`) uses the same glass styling as the homepage language switch. Keep that cohesion when editing styles.

## Adding a report (the core workflow)

Drop an `.html` into `reports/<category>/` and push — that alone makes it appear (title from `<title>`, category from folder). For a richer card, either add `report:*` meta tags to the HTML or an entry in `reports.config.json`. To pair a CN report with its EN translation, give both the same `group` so they share one card with a 中文/EN toggle (and each gets the in-report language switch). See README.md for the field list and examples.

## Invariants / gotchas

- **`dist/` is generated output** (gitignored). Never hand-edit it. Change `build.mjs` or the sources, then rebuild.
- **`build.mjs` injects a nav bar into each report's dist copy** (`injectReportNav`), but **never touches the source files** — the read-only originals stay pristine. Reports are otherwise self-contained (inline CSS; charts load Chart.js from a CDN, so they need network at view time). If you change the injected markup, only `dist/` is affected.
- **The seed Bitcoin reports (`reports/crypto/*.html`) are read-only (mode 444) final artifacts.** Don't modify their content; control their card via `reports.config.json` (they're already grouped there under `btc-cycle-bottom`).
- Hrefs URL-encode each path segment, so **UTF-8 (Chinese) filenames are fine** on GitHub and Vercel.
- The filter bar supports hash deep-links (e.g. `…/#crypto` opens that category).
- Vercel build is pinned in `vercel.json` (`buildCommand: node build.mjs`, `outputDirectory: dist`). `og:url` is only absolute when `VERCEL_PROJECT_PRODUCTION_URL` (set by Vercel) or `SITE_URL` is present.
