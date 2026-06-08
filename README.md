# 分析调研报告 · Research & Analysis

我的分析调研报告合集（美股 · 加密 · 未来学 · 宏观），以独立 HTML 形式发布，通过 **GitHub + Vercel** 自动部署，公开访问。

每次新增一个 HTML 报告并推送到 GitHub，Vercel 会自动重新构建首页并上线——**无需手动改首页**。

---

## 🗂️ 目录结构

```
.
├── reports/                 # 所有报告（按分类放在子文件夹里）
│   ├── crypto/              # 加密
│   ├── us-stocks/           # 美股
│   ├── futurology/          # 未来学
│   └── macro/               # 宏观
├── reports.config.json      # 可选：报告的元数据（摘要/日期/精选/双语分组…）
├── build.mjs                # 构建脚本：扫描 reports/ 自动生成首页
├── vercel.json              # Vercel 构建配置（已配好，导入即用）
├── package.json
└── dist/                    # 构建产物（自动生成，不进 Git，Vercel 部署的就是它）
```

---

## ➕ 如何新增一篇报告

1. 把报告的 `.html` 文件放进对应分类目录，例如 `reports/us-stocks/我的特斯拉分析.html`。
2. 推送到 GitHub：
   ```bash
   git add .
   git commit -m "add: 特斯拉分析"
   git push
   ```
3. Vercel 自动构建并上线，首页会自动出现这张卡片。✅

> 仅做到第 1 步，报告就已经能显示了（标题取自 HTML 的 `<title>`，分类取自所在文件夹）。
> 想要更精致的卡片（摘要、日期、精选标记、双语合并），见下面两种方式。

### 方式 A：在报告 HTML 里写 meta 标签（推荐，报告自带信息）

在报告 `<head>` 里加几行（都可选）：

```html
<meta name="report:category" content="us-stocks">
<meta name="report:date"     content="2026-06-15">
<meta name="report:summary"  content="一句话摘要，会显示在首页卡片上。">
<meta name="report:emoji"    content="📈">
<meta name="report:accent"   content="#34c759">
<meta name="report:featured" content="true">
```

### 方式 B：在 `reports.config.json` 里登记（适合不想改报告文件时）

以「相对 `reports/` 的路径」为 key：

```json
{
  "us-stocks/我的特斯拉分析.html": {
    "date": "2026-06-15",
    "summary": "一句话摘要。",
    "featured": true
  }
}
```

> config 的优先级高于 HTML 里的 meta。两种方式都不写也没关系。

### 双语 / 多语言报告合并成一张卡片

给同一篇报告的各语言版本设置**相同的 `group`**，它们会合并成一张卡片，并显示「中文 / EN」按钮（语言取自各文件的 `<html lang="…">`）。本仓库的比特币报告就是例子（见 `reports.config.json`）。`primary: true` 指定卡片用哪个版本的标题和摘要。

---

## 🏷️ 如何新增一个分类

1. 在 `reports/` 下新建文件夹，例如 `reports/ai/`。
2. （可选）在 `build.mjs` 顶部的 `CATEGORIES` 里加一行，设置中文名/英文名/图标/主题色：
   ```js
   'ai': { zh: 'AI', en: 'AI', emoji: '🤖', accent: '#ff375f' },
   ```
   不加也行——会用文件夹名作为分类名 + 默认样式。

---

## 💻 本地预览

```bash
node build.mjs          # 生成 dist/
open dist/index.html    # 直接用浏览器打开即可（首页是纯静态的）
# 或者起个本地服务器：
npm run preview
```

---

## ☁️ Vercel 部署（首次）

GitHub 账号已和 Vercel 关联，导入这个仓库即可：

1. 打开 [vercel.com/new](https://vercel.com/new) → 选择 `research-reports` 仓库 → **Import**。
2. 构建配置 `vercel.json` 已写好（Build Command: `node build.mjs`，Output: `dist`），保持默认直接 **Deploy**。
3. 之后每次 `git push`，Vercel 会自动重新部署。

默认访问地址为 `https://research-reports-<...>.vercel.app`，可在 Vercel 里绑定自定义域名。

---

*由 GitHub + Vercel 自动部署 · 新增报告即自动上线。*
