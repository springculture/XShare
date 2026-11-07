/* ==========================================================================
   XShare

   The data pipeline (public post API -> card -> PNG), the hand-computed media
   cropping, quote/thread handling and the export code come from an upstream
   static renderer; the card is redrawn to X desktop metrics.
   Upstream credits: see README.md.

   html2canvas-pro constraints that shape this file:
   · no `gap` on flex containers        -> margins
   · no `object-fit`                    -> cover/contain computed by hand
   · no tiled CSS gradients             -> plain colours only
   · corners live on individual cells  -> parent overflow clipping stays simple
   ========================================================================== */
'use strict';

(function () {
  const API = 'https://api.fxtwitter.com';
  /* Static hosting (GitHub Pages / Cloudflare Pages) has no server-side proxy.
     The fallback prefix is overridable without touching the source:
       ?proxy=<url-encoded-prefix>   localStorage "xshare-proxy"   XShare.setProxy()
     The original image URL is appended as encodeURIComponent(src).            */
  const DEFAULT_PROXY = 'https://api.allorigins.win/raw?url=';
  let PROXY = DEFAULT_PROXY;
  const EXAMPLE = 'https://x.com/elonmusk/status/1949938925163962634';

  /* An image taller than 2× its width is treated as a "long" image: in Auto
     mode the whole media block switches to an uncropped vertical stack so the
     bottom of that image is never cut off. */
  const LONG_RATIO = 2;
  const QUOTE_FIT_MAX = 900;      // quoted cards are kept reasonably compact
  const MAX_CANVAS_EDGE = 14000;  // Chrome refuses canvases above ~16384px
  const MAX_CANVAS_AREA = 60e6;   // and also caps total pixels

  /* X's three real themes. Values taken from the desktop client. */
  const THEMES = {
    light: {
      bg: '#ffffff', fg: '#0f1419', muted: '#536471',
      line: '#eff3f4', edge: '#eff3f4', quote: '#ffffff', blue: '#1d9bf0'
    },
    dim: {
      bg: '#15202b', fg: '#f7f9f9', muted: '#8b98a5',
      line: '#38444d', edge: '#38444d', quote: '#1e2c39', blue: '#1d9bf0'
    },
    black: {
      bg: '#000000', fg: '#e7e9ea', muted: '#71767b',
      line: '#2f3336', edge: '#2f3336', quote: '#0a0a0a', blue: '#1d9bf0'
    }
  };

  const state = {
    lang: 'zh',
    theme: 'light',
    layout: 'auto',
    ratio: 'auto',
    corners: 'round',
    quality: 2,
    stats: true,
    timestamp: false,
    chrome: false,
    watermark: false,
    root: null
  };

  const dom = {};
  let proxyNotified = false;
  let watermarkEl = null;

  /* ── helpers ──────────────────────────────────────────────────────────── */

  const $ = (s, r) => (r || document).querySelector(s);
  const t = (k) => (i18n[state.lang] && i18n[state.lang][k]) || i18n.en[k] || k;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const isZh = () => state.lang === 'zh';

  function trimNum(n) {
    return n.toFixed(1).replace(/\.0$/, '');
  }

  /* X switches its abbreviation rules with the UI language: 3.7万 vs 3.7K.
     Zero / missing counts render as an icon only, never as "0". */
  function fmtCount(n) {
    if (n == null || n === '' || isNaN(n)) return '';
    n = Number(n);
    if (n <= 0) return '';
    if (n < 1000) return String(n);
    if (isZh()) {
      if (n < 1e4) return String(n);
      if (n < 1e8) return trimNum(n / 1e4) + '万';
      return trimNum(n / 1e8) + '亿';
    }
    if (n < 1e4) return trimNum(n / 1000) + 'K';
    if (n < 1e6) return Math.round(n / 1000) + 'K';
    if (n < 1e9) return trimNum(n / 1e6) + 'M';
    return trimNum(n / 1e9) + 'B';
  }

  function parseDate(raw) {
    if (!raw) return null;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtShortDate(raw) {
    const d = parseDate(raw);
    if (!d) return '';
    if (isZh()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
    try {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
    } catch (e) { return d.toISOString().slice(5, 10); }
  }

  function fmtFullDate(raw) {
    const d = parseDate(raw);
    if (!d) return '';
    if (isZh()) return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    try {
      return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
    } catch (e) { return d.toISOString().slice(0, 10); }
  }

  function fmtClock(raw) {
    const d = parseDate(raw);
    if (!d) return '';
    if (!isZh()) {
      try {
        return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);
      } catch (e) { return ''; }
    }
    const h = d.getHours();
    const ap = h < 12 ? '上午' : '下午';
    const hh = h % 12 === 0 ? 12 : h % 12;
    return ap + hh + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtRelative(raw) {
    const d = parseDate(raw);
    if (!d) return '';
    const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (secs < 60) return isZh() ? '刚刚' : 'now';
    if (secs < 3600) return Math.floor(secs / 60) + (isZh() ? '分钟' : 'm');
    if (secs < 86400) return Math.floor(secs / 3600) + (isZh() ? '小时' : 'h');
    const days = Math.floor(secs / 86400);
    if (days < 7) return days + (isZh() ? '天' : 'd');
    return fmtShortDate(raw);
  }

  /* ── toasts ───────────────────────────────────────────────────────────── */

  function toast(message, kind) {
    const el = document.createElement('div');
    el.className = 'toast toast--' + (kind || 'info');
    el.textContent = message;
    dom.toasts.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 220);
    }, 3600);
    while (dom.toasts.children.length > 3) dom.toasts.firstChild.remove();
  }

  /* ── i18n ─────────────────────────────────────────────────────────────── */

  function initLang() {
    const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
    state.lang = i18n[nav] ? nav : 'en';
    document.documentElement.lang = state.lang;
    const dict = i18n[state.lang];
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const v = dict[el.dataset.i18n];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const v = dict[el.dataset.i18nPlaceholder];
      if (v != null) el.placeholder = v;
    });
    document.title = dict.pageTitle || document.title;
  }

  /* ── url → api ────────────────────────────────────────────────────────── */

  function parseTweetUrl(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    const host = u.hostname.replace(/^(www\.|mobile\.|m\.)/i, '').toLowerCase();
    const known = ['x.com', 'twitter.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com', 'twittpr.com'];
    if (known.indexOf(host) === -1 && !host.endsWith('.x.com') && !host.endsWith('.twitter.com')) return null;
    const m = u.pathname.match(/\/(?:([A-Za-z0-9_]{1,20})\/)?status(?:es)?\/(\d+)/);
    if (!m) return null;
    return { user: m[1] || 'i', id: m[2] };
  }

  async function fetchTweet(user, id) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(`${API}/${user}/status/${id}`, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.code !== 200 || !json.tweet) throw new Error(json.message || 'No tweet in response');
      return json.tweet;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── images ───────────────────────────────────────────────────────────── */

  function loadImage(img, src) {
    const local = /^(data|blob):/.test(src);
    if (!local) img.crossOrigin = 'anonymous';
    img.onerror = () => {
      if (local || img.dataset.fallback || !PROXY) return;
      img.dataset.fallback = '1';
      if (!proxyNotified) {
        proxyNotified = true;
        toast(t('toastProxy'), 'info');
      }
      img.removeAttribute('crossorigin');
      img.src = PROXY + encodeURIComponent(src);
    };
    img.src = src;
  }

  /* html2canvas has no object-fit, so both modes are computed as explicit px:
     · cover   — fills the cell, crops the overflow (native X grid)
     · contain — fits the whole image, never crops (long images)            */
  function makeCell(src, cw, ch, mr, mb, intrinsic, mode) {
    const cell = document.createElement('div');
    cell.style.cssText =
      'position:relative;flex:0 0 auto;overflow:hidden;' +
      `width:${cw}px;height:${ch}px;` +
      `margin-right:${mr}px;margin-bottom:${mb}px;background:var(--c-line)`;

    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';

    const place = (iw, ih) => {
      if (!iw || !ih) return;
      const scale = mode === 'contain'
        ? Math.min(cw / iw, ch / ih)
        : Math.max(cw / iw, ch / ih);
      const w = Math.max(1, Math.round(iw * scale));
      const h = Math.max(1, Math.round(ih * scale));
      img.style.cssText =
        'position:absolute;max-width:none;max-height:none;display:block;' +
        `width:${w}px;height:${h}px;left:${Math.round((cw - w) / 2)}px;top:${Math.round((ch - h) / 2)}px`;
    };

    const iw = intrinsic && intrinsic.width ? intrinsic.width : 0;
    const ih = intrinsic && intrinsic.height ? intrinsic.height : 0;
    if (iw && ih) place(iw, ih);
    else img.style.cssText =
      `position:absolute;inset:0;width:100%;height:100%;display:block;object-fit:${mode}`;

    /* API dimensions are usually right — re-measure on load so a wrong value
       can never leave an image cropped or letterboxed by accident. */
    img.addEventListener('load', () => {
      if (img.naturalWidth && img.naturalHeight) place(img.naturalWidth, img.naturalHeight);
    });

    loadImage(img, src);
    cell.appendChild(img);
    return cell;
  }

  function coverCell(src, cw, ch, mr, mb, intrinsic) {
    return makeCell(src, cw, ch, mr, mb, intrinsic, 'cover');
  }

  function containCell(src, cw, ch, mr, mb, intrinsic) {
    return makeCell(src, cw, ch, mr, mb, intrinsic, 'contain');
  }

  /* Only the outer corners of a grid are rounded — just like X. */
  function roundCell(cell, r) {
    const R = state.corners === 'square' ? 0 : 16;
    cell.style.borderTopLeftRadius = (r[0] ? R : 0) + 'px';
    cell.style.borderTopRightRadius = (r[1] ? R : 0) + 'px';
    cell.style.borderBottomRightRadius = (r[2] ? R : 0) + 'px';
    cell.style.borderBottomLeftRadius = (r[3] ? R : 0) + 'px';
  }

  /* ── media ────────────────────────────────────────────────────────────── */

  function mediaItems(media) {
    if (!media) return [];
    const out = [];
    (media.photos || []).forEach((p) => out.push({ src: p.url, width: p.width, height: p.height }));
    if (!out.length && media.videos && media.videos.length) {
      media.videos.forEach((v) => {
        if (v.thumbnail_url) out.push({ src: v.thumbnail_url, width: v.width, height: v.height });
      });
    }
    return out;
  }

  function ratioOf(it) {
    return it.width && it.height ? it.height / it.width : 0.56;
  }

  /* "waterfall" stays as an alias so older links and scripts keep working. */
  function layoutMode() {
    if (state.layout === 'waterfall') return 'stack';
    if (state.layout === 'auto' || state.layout === 'grid' || state.layout === 'stack') return state.layout;
    return 'auto';
  }

  /* Uncropped vertical stack: every image keeps its full aspect ratio.
     maxH > 0 caps the box height; an even taller image is letterboxed (still
     complete, just smaller) — used for quoted posts so they stay compact. */
  function renderFullStack(items, wrap, W, maxH) {
    items.forEach((it, i) => {
      const natural = Math.round(W * ratioOf(it));
      const h = Math.max(60, maxH ? Math.min(natural, maxH) : natural);
      const last = i === items.length - 1;
      const c = containCell(it.src, W, h, 0, last ? 0 : 2, it);
      roundCell(c, [1, 1, 1, 1]);
      wrap.appendChild(c);
    });
  }

  function renderMedia(media, wrap, opts) {
    wrap.innerHTML = '';
    const items = mediaItems(media);
    if (!items.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';

    const options = opts || {};
    const G = 2;                    // X uses a 2px gutter between photos
    const W = Math.round(wrap.clientWidth);
    if (!W) {
      const tries = (wrap.__measureTries || 0) + 1;
      wrap.__measureTries = tries;
      if (tries <= 6) requestAnimationFrame(() => renderMedia(media, wrap, opts));
      return;
    }
    wrap.__measureTries = 0;

    const mode = layoutMode();
    const hasLong = items.some((it) => ratioOf(it) >= LONG_RATIO);
    const full = mode === 'stack' || (mode === 'auto' && hasLong);

    if (options.quote) {
      if (full) {
        renderFullStack(items, wrap, W, QUOTE_FIT_MAX);
      } else {
        const it = items[0];
        const h = Math.max(60, Math.min(Math.round(W * ratioOf(it)), 260));
        const c = coverCell(it.src, W, h, 0, 0, it);
        const R = state.corners === 'square' ? 0 : 12;
        c.style.borderRadius = R + 'px';
        wrap.appendChild(c);
      }
      return;
    }

    /* Auto mode also gives a single normal image its full aspect ratio instead
       of cropping it to X's 510px cap. Grid mode keeps the native behaviour. */
    if (full || (mode === 'auto' && items.length === 1)) {
      renderFullStack(items, wrap, W, 0);
      return;
    }

    if (items.length === 1) {
      const it = items[0];
      const h = Math.max(110, Math.min(Math.round(W * ratioOf(it)), 510));
      const c = coverCell(it.src, W, h, 0, 0, it);
      roundCell(c, [1, 1, 1, 1]);
      wrap.appendChild(c);
      return;
    }

    const n = Math.min(items.length, 4);
    const gridH = Math.round(W * 0.56);   // X caps a multi-photo block near 16:9
    const cells = [];

    if (n === 2) {
      const cw = Math.floor((W - G) / 2);
      cells.push(coverCell(items[0].src, cw, gridH, G, 0, items[0]));
      cells.push(coverCell(items[1].src, cw, gridH, 0, 0, items[1]));
      roundCell(cells[0], [1, 0, 0, 1]);
      roundCell(cells[1], [0, 1, 1, 0]);
    } else if (n === 3) {
      const lw = Math.round((W - G) * 0.61);
      const rw = W - G - lw;
      const rh = Math.floor((gridH - G) / 2);
      cells.push(coverCell(items[0].src, lw, gridH, G, 0, items[0]));
      cells.push(coverCell(items[1].src, rw, rh, 0, G, items[1]));
      cells.push(coverCell(items[2].src, rw, rh, 0, 0, items[2]));
      roundCell(cells[0], [1, 0, 0, 1]);
      roundCell(cells[1], [0, 1, 0, 0]);
      roundCell(cells[2], [0, 0, 1, 0]);
    } else {
      const cw = Math.floor((W - G) / 2);
      const ch = Math.floor((gridH - G) / 2);
      for (let i = 0; i < 4; i++) {
        cells.push(coverCell(items[i].src, cw, ch, i % 2 === 0 ? G : 0, i < 2 ? G : 0, items[i]));
      }
      roundCell(cells[0], [1, 0, 0, 0]);
      roundCell(cells[1], [0, 1, 0, 0]);
      roundCell(cells[2], [0, 0, 0, 1]);
      roundCell(cells[3], [0, 0, 1, 0]);
    }

    cells.forEach((c) => wrap.appendChild(c));
  }

  /* ── card ─────────────────────────────────────────────────────────────── */

  const CARD_VARS = ['--c-bg', '--c-fg', '--c-muted', '--c-line', '--c-edge', '--c-quote', '--c-blue'];

  function applyTheme(cardEl) {
    const theme = THEMES[state.theme] || THEMES.light;
    CARD_VARS.forEach((p) => cardEl.style.removeProperty(p));
    Object.keys(theme).forEach((k) => cardEl.style.setProperty('--c-' + k, theme[k]));
  }

  function applyThemeAll() {
    dom.capture.querySelectorAll('.card').forEach(applyTheme);
  }

  /* Safe rich text: @mentions, #hashtags and links are tinted, never injected. */
  function renderRichText(el, text) {
    const str = String(text || '');
    el.textContent = '';
    const re = /(https?:\/\/[^\s]+|@[A-Za-z0-9_]{1,20}|#[^\s#@,，。！?？]+)/g;
    let last = 0, m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) el.appendChild(document.createTextNode(str.slice(last, m.index)));
      const span = document.createElement('span');
      const token = m[0];
      span.className = token.charAt(0) === '#' ? 'hashtag' : (token.charAt(0) === '@' ? 'mention' : 'url');
      span.textContent = token.length > 34 ? token.slice(0, 31) + '…' : token;
      el.appendChild(span);
      last = re.lastIndex;
    }
    if (last < str.length) el.appendChild(document.createTextNode(str.slice(last)));
  }

  function setCount(card, cls, value) {
    const el = card.querySelector(cls);
    if (el) el.textContent = fmtCount(value);
  }

  function buildCard(tweet) {
    let core = tweet;
    let reposter = null;
    if (tweet.retweeted_status) {
      core = tweet.retweeted_status;
      reposter = tweet.author;
    } else if (tweet.reposted_by) {
      reposter = tweet.reposted_by;
    }

    const frag = document.importNode($('#tpl-card').content, true);
    const card = frag.querySelector('.card');
    const author = core.author || {};

    const ctx = card.querySelector('.card__context');
    if (reposter && reposter.name) {
      ctx.hidden = false;
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      icon.innerHTML = '<path d="m17 1 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 23-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
      ctx.appendChild(icon);
      ctx.appendChild(document.createTextNode(t('retweetedBy') + ' ' + reposter.name));
    }

    card.querySelector('.card__name').textContent = author.name || '—';

    const verified = (author.verification && author.verification.verified) || author.verified;
    if (verified) card.querySelector('.card__badge').hidden = false;

    card.querySelector('.card__handle').textContent = '@' + (author.screen_name || 'unknown');

    const rel = fmtRelative(core.created_at);
    const timeEl = card.querySelector('.card__time');
    const sepEl = card.querySelector('.card__sep');
    if (rel) timeEl.textContent = rel;
    else { timeEl.hidden = true; sepEl.hidden = true; }

    if (author.avatar_url) loadImage(card.querySelector('.card__avatar'), author.avatar_url);
    else card.querySelector('.card__avatar').style.visibility = 'hidden';

    renderRichText(card.querySelector('.card__text'), core.text || '');

    if (core.quote) {
      const q = core.quote;
      const qa = q.author || {};
      card.querySelector('.card__quote').hidden = false;
      card.querySelector('.card__quote-name').textContent = qa.name || '—';
      card.querySelector('.card__quote-handle').textContent = '@' + (qa.screen_name || '');
      renderRichText(card.querySelector('.card__quote-text'), q.text || '');
      const qd = fmtShortDate(q.created_at);
      if (qd) card.querySelector('.card__quote-time').textContent = qd;
      else {
        card.querySelector('.card__quote-time').hidden = true;
        card.querySelector('.card__quote-sep').hidden = true;
      }
      if (qa.avatar_url) loadImage(card.querySelector('.card__quote-avatar'), qa.avatar_url);
      else card.querySelector('.card__quote-avatar').style.visibility = 'hidden';
    }

    /* Expanded-view timestamp line. */
    const full = fmtFullDate(core.created_at);
    const clock = fmtClock(core.created_at);
    const ts = card.querySelector('.card__timestamp');
    const views = fmtCount(core.views);
    if (full || clock) {
      const bits = [clock, full].filter(Boolean).join(' · ');
      ts.textContent = views ? bits + ' · ' + views + ' ' + t('viewsLabel') : bits;
    } else {
      ts.textContent = '';
    }
    ts.hidden = !ts.textContent || !state.timestamp || !state.stats;

    setCount(card, '.stat-replies', core.replies);
    setCount(card, '.stat-retweets', core.retweets);
    setCount(card, '.stat-likes', core.likes);
    setCount(card, '.stat-views', core.views);
    /* X never exposes bookmark/share totals publicly — icons only, like the
       zero-count case. Showing FxEmbed's numbers here would look wrong. */
    card.querySelector('.stat-bookmarks').textContent = '';
    card.querySelector('.stat-shares').textContent = '';

    applyTheme(card);
    refreshFlags();
    return { card, core };
  }

  function parentGap(user, id) {
    const gap = document.createElement('div');
    gap.className = 'thread-gap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'parent-btn';
    btn.dataset.user = user;
    btn.dataset.id = id;
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
    btn.appendChild(document.createTextNode(t('showParentTweet')));
    gap.appendChild(btn);
    return gap;
  }

  function renderCardMedia(card) {
    if (card.__media !== undefined) renderMedia(card.__media, card.querySelector('.card__media'));
    if (card.__quoteMedia) {
      renderMedia(card.__quoteMedia, card.querySelector('.card__quote-media'), { quote: true });
    }
  }

  function refreshAllMedia() {
    dom.capture.querySelectorAll('.card').forEach(renderCardMedia);
    requestAnimationFrame(applyRatio);
  }

  function mountTweet(tweet, before) {
    const { card, core } = buildCard(tweet);
    const nodes = [];
    if (core.replying_to && core.replying_to_status) {
      nodes.push(parentGap(core.replying_to, core.replying_to_status));
    }
    nodes.push(card);
    nodes.forEach((n) => dom.capture.insertBefore(n, before || null));

    card.__media = core.media;
    card.__quoteMedia = core.quote ? core.quote.media : null;
    renderCardMedia(card);
    requestAnimationFrame(applyRatio);
    return { card, core };
  }

  function clearCapture() {
    dom.capture.innerHTML = '';
    watermarkEl = null;
    state.root = null;
  }

  function refreshFlags() {
    dom.capture.classList.toggle('is-hide-stats', !state.stats);
    dom.capture.classList.toggle('is-hide-chrome', !state.chrome);
    dom.capture.classList.toggle('is-square', state.corners === 'square');
    dom.capture.querySelectorAll('.card__timestamp').forEach((el) => {
      el.hidden = !state.timestamp || !state.stats || !el.textContent;
    });
  }

  /* Locked ratios pad the export area with explicit px — html2canvas doesn't have
     to resolve a flex `justify-content: center` that way. */
  function applyRatio() {
    if (!dom.capture.querySelector('.card')) return;
    const cs = dom.capture.style;
    cs.paddingTop = '0px';
    cs.paddingBottom = '0px';
    cs.minHeight = '';
    if (state.ratio === 'auto') return;

    const W = dom.capture.clientWidth || 598;
    const factor = state.ratio === '3:4' ? 4 / 3 : 16 / 9;
    const H = Math.round(W * factor);
    const contentH = dom.capture.scrollHeight;
    if (contentH >= H) return;
    const pad = Math.round((H - contentH) / 2);
    cs.paddingTop = pad + 'px';
    cs.paddingBottom = pad + 'px';
  }

  /* Radio-style spec list: the trailing <b> shows ● or ○. */
  function initSpec(el, onChange) {
    const buttons = Array.from(el.querySelectorAll('button'));
    function sync(value) {
      buttons.forEach((b) => {
        const on = b.dataset.value === String(value);
        b.setAttribute('aria-pressed', String(on));
        const mark = b.querySelector('b');
        if (mark) mark.textContent = on ? '●' : '○';
      });
    }
    buttons.forEach((b) => {
      b.addEventListener('click', () => {
        sync(b.dataset.value);
        if (onChange) onChange(b.dataset.value);
      });
    });
    return sync;
  }

  /* ── offline example ──────────────────────────────────────────────────── */

  function svgDataUri(svg) {
    /* One encoding pass only: encodeURIComponent already turns # into %23. */
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function demoPhoto(w, h, bg, label) {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='" + h + "' viewBox='0 0 " + w + " " + h + "'>" +
      "<rect width='100%' height='100%' fill='" + bg + "'/>" +
      "<circle cx='" + Math.round(w * 0.74) + "' cy='" + Math.round(h * 0.28) + "' r='" + Math.round(Math.min(w, h) * 0.24) + "' fill='#ffffff' fill-opacity='0.18'/>" +
      "<circle cx='" + Math.round(w * 0.16) + "' cy='" + Math.round(h * 0.9) + "' r='" + Math.round(Math.min(w, h) * 0.34) + "' fill='#000000' fill-opacity='0.10'/>" +
      "<text x='22' y='" + (h - 22) + "' font-family='Arial,sans-serif' font-size='20' font-weight='bold' fill='#ffffff' fill-opacity='0.92'>" + label + "</text>" +
      "</svg>";
    return svgDataUri(svg);
  }

  function demoAvatar(bg, letter) {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'>" +
      "<circle cx='48' cy='48' r='48' fill='" + bg + "'/>" +
      "<text x='48' y='62' text-anchor='middle' font-family='Arial,sans-serif' font-size='42' font-weight='bold' fill='#ffffff'>" + letter + "</text>" +
      "</svg>";
    return svgDataUri(svg);
  }

  function demoTweet() {
    const now = Date.now();
    const ago = (ms) => new Date(now - ms).toISOString();
    return {
      id: 'demo-1949938925163962634',
      created_at: ago(2 * 3600 * 1000),
      author: {
        name: 'XShare', screen_name: 'xshare',
        avatar_url: demoAvatar('#1d9bf0', 'X'),
        verification: { verified: true }
      },
      text: '把一条推文的正文和全部配图，排进同一张按 X 桌面端版式绘制的卡片。\n\n598px 正文栏 · 40px 头像 · 16px 圆角 · 2px 图间隙，@mention、#话题 和 https://example.com/a-very-long-link 也会像原生一样变蓝。',
      media: {
        photos: [
          { url: demoPhoto(800, 600, '#2f6db5', '01'), width: 800, height: 600 },
          { url: demoPhoto(800, 600, '#1a8f8a', '02'), width: 800, height: 600 },
          { url: demoPhoto(800, 600, '#c15b8a', '03'), width: 800, height: 600 },
          { url: demoPhoto(600, 1800, '#d98a34', '04 LONG'), width: 600, height: 1800 }
        ]
      },
      quote: {
        created_at: ago(26 * 3600 * 1000),
        author: {
          name: 'FxEmbed', screen_name: 'fxembed',
          avatar_url: demoAvatar('#0f1419', 'F')
        },
        text: '数据来自公开的 FxEmbed 接口，不需要 X API key。引用推连同它自己的配图一起还原。',
        media: { photos: [{ url: demoPhoto(900, 500, '#5a4b9c', 'QUOTE'), width: 900, height: 500 }] }
      },
      replies: 128, retweets: 342, likes: 26000, views: 910000,
      bookmarks: 0, shares: 0
    };
  }

  /* ── export ───────────────────────────────────────────────────────────── */

  function ensureWatermark() {
    if (!watermarkEl) {
      watermarkEl = document.createElement('div');
      watermarkEl.className = 'capture__watermark';
      watermarkEl.textContent = 'XShare';
      dom.capture.appendChild(watermarkEl);
    }
    watermarkEl.hidden = !state.watermark;
    return watermarkEl;
  }

  async function renderCanvas() {
    if (!dom.capture.querySelector('.card')) {
      toast(t('toastNoData'), 'error');
      return null;
    }
    if (typeof html2canvas !== 'function') {
      toast('Renderer failed to load.', 'error');
      return null;
    }

    ensureWatermark();
    dom.capture.classList.add('is-capturing');
    applyRatio();

    /* Uncropped long images can make the card very tall. Chrome refuses
       canvases beyond ~16384px per side / ~268M pixels, so dial the export
       scale down just enough instead of failing or clipping the image. */
    const contentW = dom.capture.clientWidth || 598;
    const contentH = dom.capture.scrollHeight || contentW;
    const byEdge = MAX_CANVAS_EDGE / Math.max(contentW, contentH);
    const byArea = Math.sqrt(MAX_CANVAS_AREA / Math.max(contentW * contentH, 1));
    const scale = Math.max(0.25, Math.min(state.quality, byEdge, byArea));
    if (scale < state.quality - 0.01) toast(t('toastScale'), 'info');

    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      await nextFrame();
      await nextFrame();
      return await html2canvas(dom.capture, {
        scale,
        useCORS: true,
        allowTaint: false,
        backgroundColor: null,
        logging: false,
        imageTimeout: 20000
      });
    } catch (err) {
      console.error(err);
      toast('Render failed — ' + err.message, 'error');
      return null;
    } finally {
      dom.capture.classList.remove('is-capturing');
      if (watermarkEl) watermarkEl.hidden = !state.watermark;
      refreshAllMedia();
    }
  }

  function downloadName() {
    const a = state.root && state.root.author ? state.root.author.screen_name : 'post';
    const id = state.root ? state.root.id : Date.now();
    return 'XShare-' + a + '-' + id + '.png';
  }

  const canvasToBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

  async function download() {
    dom.downloadBtn.disabled = true;
    try {
      const canvas = await renderCanvas();
      if (!canvas) return;
      const blob = await canvasToBlob(canvas);
      if (!blob) { toast('Could not encode image.', 'error'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast(t('toastDownload'), 'success');
    } finally {
      dom.downloadBtn.disabled = false;
    }
  }

  async function copyImage() {
    if (!navigator.clipboard || !window.ClipboardItem) {
      toast(t('toastCopyFail'), 'error');
      return;
    }
    dom.copyBtn.disabled = true;
    try {
      const canvas = await renderCanvas();
      if (!canvas) return;
      const blob = await canvasToBlob(canvas);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(t('toastCopied'), 'success');
    } catch (err) {
      console.error(err);
      toast(t('toastCopyFail'), 'error');
    } finally {
      dom.copyBtn.disabled = false;
    }
  }

  /* ── flow ─────────────────────────────────────────────────────────────── */

  function showPlate(tweet, core) {
    dom.empty.hidden = true;
    dom.plate.hidden = false;
    const handle = core.author && core.author.screen_name ? '@' + core.author.screen_name : '';
    const themeName = (THEMES[state.theme] ? state.theme : 'light');
    dom.caption.textContent = [handle, fmtFullDate(core.created_at), themeName, '598px'].filter(Boolean).join(' · ');
  }

  function present(tweet, isDemo) {
    clearCapture();
    const { core } = mountTweet(tweet);
    state.root = tweet;
    ensureWatermark();
    showPlate(tweet, core);
    if (isDemo) toast(t('toastFallback'), 'info');
    else toast(t('toastSuccess'), 'success');
  }

  function loadDemo() {
    present(demoTweet(), false);
  }

  async function generate(input) {
    const parsed = parseTweetUrl(input);
    if (!parsed) {
      toast(t('toastInvalidLink'), 'error');
      return;
    }
    dom.composer.classList.add('is-busy');
    dom.fetchBtn.disabled = true;
    toast(t('toastFetch'), 'info');
    try {
      const tweet = await fetchTweet(parsed.user, parsed.id);
      present(tweet, false);
    } catch (err) {
      console.error(err);
      if (!dom.capture.querySelector('.card')) {
        present(demoTweet(), true);
      } else {
        toast(t('toastFailure') + (err.message || err), 'error');
      }
    } finally {
      dom.composer.classList.remove('is-busy');
      dom.fetchBtn.disabled = false;
    }
  }

  async function loadParent(btn) {
    if (!btn.dataset.user || !btn.dataset.id) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = t('loadingParent');
    try {
      const tweet = await fetchTweet(btn.dataset.user, btn.dataset.id);
      const gap = btn.closest('.thread-gap');
      mountTweet(tweet, gap || btn.closest('.card'));
      if (gap) gap.remove();
      refreshAllMedia();
    } catch (err) {
      console.error(err);
      toast(t('toastParentFail'), 'error');
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */

  function bind() {
    dom.composer.addEventListener('submit', (e) => {
      e.preventDefault();
      generate(dom.urlInput.value);
    });
    dom.exampleBtn.addEventListener('click', () => {
      dom.urlInput.value = EXAMPLE;
      generate(EXAMPLE);
    });
    dom.demoBtn.addEventListener('click', loadDemo);

    dom.themeSync = initSpec(dom.themeSeg, (v) => {
      state.theme = v;
      applyThemeAll();
      refreshFlags();
    });
    dom.layoutSync = initSpec(dom.layoutSeg, (v) => {
      state.layout = v;
      refreshAllMedia();
    });
    dom.ratioSync = initSpec(dom.ratioSeg, (v) => {
      state.ratio = v;
      applyRatio();
    });
    dom.cornersSync = initSpec(dom.cornersSeg, (v) => {
      state.corners = v;
      refreshFlags();
      refreshAllMedia();
    });
    dom.qualitySync = initSpec(dom.qualitySeg, (v) => {
      state.quality = Number(v);
    });

    dom.themeSync(state.theme);
    dom.layoutSync(state.layout);
    dom.ratioSync(state.ratio);
    dom.cornersSync(state.corners);
    dom.qualitySync(state.quality);

    dom.optStats.addEventListener('change', () => {
      state.stats = dom.optStats.checked;
      refreshFlags();
    });
    dom.optTimestamp.addEventListener('change', () => {
      state.timestamp = dom.optTimestamp.checked;
      refreshFlags();
      applyRatio();
    });
    dom.optChrome.addEventListener('change', () => {
      state.chrome = dom.optChrome.checked;
      refreshFlags();
    });
    dom.optWatermark.addEventListener('change', () => {
      state.watermark = dom.optWatermark.checked;
      if (watermarkEl) watermarkEl.hidden = !state.watermark;
    });

    dom.downloadBtn.addEventListener('click', download);
    dom.copyBtn.addEventListener('click', copyImage);

    dom.capture.addEventListener('click', (e) => {
      const btn = e.target.closest('.parent-btn');
      if (btn) loadParent(btn);
    });

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dom.capture.querySelector('.card')) download();
      }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { refreshAllMedia(); applyRatio(); }, 180);
    });
  }

  function collect() {
    dom.composer = $('#composer');
    dom.urlInput = $('#tweet-url');
    dom.fetchBtn = $('#fetch-btn');
    dom.exampleBtn = $('#example-btn');
    dom.demoBtn = $('#demo-btn');
    dom.empty = $('#empty');
    dom.plate = $('#plate');
    dom.caption = $('#caption');
    dom.capture = $('#capture-area');
    dom.toasts = $('#toast-container');

    dom.themeSeg = $('#theme-seg');
    dom.layoutSeg = $('#layout-seg');
    dom.ratioSeg = $('#ratio-seg');
    dom.cornersSeg = $('#corners-seg');
    dom.qualitySeg = $('#quality-seg');

    dom.optStats = $('#opt-stats');
    dom.optTimestamp = $('#opt-timestamp');
    dom.optChrome = $('#opt-chrome');
    dom.optWatermark = $('#opt-watermark');
    dom.downloadBtn = $('#download-btn');
    dom.copyBtn = $('#copy-btn');
  }

  function boot() {
    collect();
    initLang();
    bind();
    refreshFlags();
    ensureWatermark();

    window.XShare = {
      generate,
      loadDemo,
      download,
      copyImage,
      render: renderCanvas,
      refresh: refreshAllMedia,
      mount: mountTweet,
      setTheme: (v) => {
        if (!THEMES[v]) return;
        state.theme = v;
        dom.themeSync(v);
        applyThemeAll();
      },
      setRatio: (v) => { state.ratio = v; dom.ratioSync(v); applyRatio(); },
      setLayout: (v) => {
        const map = { auto: 'auto', grid: 'grid', stack: 'stack', waterfall: 'stack' };
        state.layout = map[v] || 'auto';
        dom.layoutSync(state.layout);
        refreshAllMedia();
        return state.layout;
      },
      setCorners: (v) => { state.corners = v; dom.cornersSync(v); refreshFlags(); refreshAllMedia(); },
      setProxy: (v, persist = true) => {
        PROXY = (!v || v === 'none') ? '' : String(v);
        if (persist) {
          try { localStorage.setItem('xshare-proxy', PROXY); } catch (e) { /* storage blocked */ }
        }
        proxyNotified = false;
        refreshAllMedia();
        return PROXY;
      },
      getProxy: () => PROXY,
      state
    };

    const q = new URLSearchParams(location.search);
    try {
      const saved = localStorage.getItem('xshare-proxy');
      if (saved !== null) PROXY = saved;
    } catch (e) { /* storage blocked */ }
    if (q.has('proxy')) window.XShare.setProxy(q.get('proxy'), false);
    if (q.get('theme') && THEMES[q.get('theme')]) window.XShare.setTheme(q.get('theme'));
    if (q.get('layout')) window.XShare.setLayout(q.get('layout'));
    if (q.get('ratio') && q.get('ratio') !== 'auto') window.XShare.setRatio(q.get('ratio'));
    if (q.get('corners') === 'square') window.XShare.setCorners('square');
    const deep = q.get('url');
    if (deep) {
      dom.urlInput.value = deep;
      generate(deep);
    } else if (q.get('demo')) {
      window.XShare.loadDemo();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
