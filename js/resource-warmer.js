"use strict";

// Discover destination-page resources without executing or attaching destination markup.
(() => {
  if (globalThis.fasterPageloadResourceWarmerLoaded) return;
  globalThis.fasterPageloadResourceWarmerLoaded = true;

  const { decodedPathAndQuery, isUnsafePath, linkSettled } = globalThis.snappyPageload;

  const MAX_PAGE_BYTES = 2 * 1024 * 1024;
  const MAX_CSS_BYTES = 512 * 1024;
  const MAX_DEPTH = 2;
  const MAX_PAGES = 30;
  const MAX_ASSETS = 100;
  const MAX_PER_PAGE = 20;
  const MAX_IMAGES = 6;
  const MAX_OUTSTANDING_HINTS = 4;
  const HINT_TIMEOUT_MS = 5_000;
  const MAX_TEXT_CHARS = 50_000;
  const TIMEOUT_MS = 10_000;
  const state = { pages: new Map(), hints: new Map(), css: new Set() };

  // Trackers, hit counters and captchas change server state or burn challenges when fetched.
  // Words must be a whole path/query token (delimited by anything but letters and digits), so
  // ordinary names like "uploads", "adobe" or "shadow" never match; "ad"/"ads" only as a token.
  // False positives only cost a missed hint.
  const TRACKER_ASSET = /(?:^|[^a-z0-9])(?:pixel|beacon|track|tracking|tracker|analytics|collect|(?:re)?captcha|counter|ads?)(?:[^a-z0-9]|$)/i;
  const IMAGE_TYPES = "avif|webp|png|jpeg|gif|svg\\+xml";
  const SUPPORTED_IMAGE_TYPE = new RegExp(`^image/(?:${IMAGE_TYPES})$`, "i");
  const SAFE_HINT_TYPE = new RegExp(
    `^(?:text/css|(?:text|application)/(?:javascript|ecmascript)|image/(?:${IMAGE_TYPES})|font/(?:woff|woff2|ttf|otf))$`, "i");
  // Copied to the hint and part of its identity.
  const HINT_ATTRS = ["integrity", "referrerpolicy", "media", "imagesrcset", "imagesizes"];

  // Runs at most `max` tasks at once; the returned promise resolves with the task's result,
  // or undefined if it failed.
  function limiter(max) {
    let active = 0;
    const queue = [];
    const next = () => {
      while (active < max && queue.length) {
        const { task, resolve } = queue.shift();
        active++;
        task().then(resolve, () => resolve()).finally(() => { active--; next(); });
      }
    };
    return (task) => new Promise((resolve) => { queue.push({ task, resolve }); next(); });
  }

  // Firefox supports prefetch (idle priority, meant for the next navigation); preload there
  // is for the current page and logs "preloaded but not used" warnings. Safari lacks prefetch.
  const prefetchSupported = document.createElement("link").relList?.supports?.("prefetch") === true;
  const hintStrategy = prefetchSupported
    ? {
      rel: () => "prefetch",
      lowPriority: false,
      // Firefox prefetch has no imagesrcset, so we choose one candidate ourselves.
      browserChoosesSrcset: false,
      // Firefox's prefetch service already queues links (a few in parallel, after the page loaded).
      place: (task) => task(),
    }
    : {
      rel: (kind) => (kind === "module" ? "modulepreload" : "preload"),
      lowPriority: true,
      // Safari's preload link keeps the whole srcset and the browser chooses.
      browserChoosesSrcset: true,
      // Preloads start at once, so each hint holds a slot until it settles and a page never
      // floods the connection.
      place: limiter(MAX_OUTSTANDING_HINTS),
    };

  const schedule = limiter(4);
  const idle = () => Promise.resolve({ pages: 0, assets: 0 });

  // The only URL gate: http(s) without credentials, never an https to http downgrade, no fragment.
  function safeUrl(value, base) {
    if (!value || /^\s*(?:#|(?:data|blob|javascript|mailto|tel):)/i.test(value)) return null;
    let url;
    try { url = new URL(value, base); } catch { return null; }
    url.hash = "";
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (location.protocol === "https:" && url.protocol === "http:") return null;
    return url;
  }

  // Resolves to { text, url } (url is the final, same-origin response URL) or null.
  function boundedFetch(url, limit, contentType, deadline, cache) {
    return schedule(async () => {
      if (Date.now() >= deadline) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline - Date.now());
      const discard = async (stream) => { await stream?.cancel(); return null; };
      try {
        // Same-origin only, so the custom headers cannot trigger a CORS preflight. They let
        // servers recognise a speculative request.
        const response = await fetch(url.href, {
          mode: "same-origin", credentials: "same-origin", cache, redirect: "follow",
          headers: { "X-Moz": "prefetch", Purpose: "prefetch" },
          signal: controller.signal,
        });
        const finalUrl = safeUrl(response.url || url.href, url.href);
        const type = (response.headers.get("content-type") || "").toLowerCase();
        if (finalUrl?.origin !== url.origin || !response.ok || !type.includes(contentType) ||
            Number(response.headers.get("content-length")) > limit) {
          return await discard(response.body);
        }
        const reader = response.body?.getReader();
        if (!reader) return { text: "", url: finalUrl };
        const decoder = new TextDecoder();
        let text = "";
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) return await discard(reader);
          text += decoder.decode(value, { stream: true });
        }
        return { text: text + decoder.decode(), url: finalUrl };
      } finally { clearTimeout(timer); }
    });
  }

  function decodeCss(value) {
    if (!value.includes("\\")) return value;
    return value.replace(/\\([\da-f]{1,6}\s?|\r\n|\n|\r|.)/gi, (_, escape) => {
      if (/^[\da-f]/i.test(escape)) {
        const code = parseInt(escape.trim(), 16);
        return !code || code > 0x10ffff ? "�" : String.fromCodePoint(code);
      }
      return /^[\r\n]/.test(escape) ? "" : escape;
    });
  }

  // CSS scanning helpers. Each takes the text and an index and returns a new index.
  const NAME_CHAR = /[\w-]/;
  const SPACE = /\s+/y;
  // Positions where cssResources has anything to do; everything else is skipped over.
  const RESOURCE_START = /["'/@uU]/g;
  const BLOCK_START = /["'/{}]/g;
  const DECLARATION_START = /["'/;()]/g;

  // After the comment that starts at css[i], or i when there is none (an unterminated one runs to the end).
  function skipComment(css, i) {
    if (css[i] !== "/" || css[i + 1] !== "*") return i;
    const end = css.indexOf("*/", i + 2);
    return end < 0 ? css.length : end + 2;
  }

  // Whitespace and comments, in any order.
  function skipBlank(css, i) {
    while (true) {
      SPACE.lastIndex = i;
      if (SPACE.test(css)) i = SPACE.lastIndex;
      const next = skipComment(css, i);
      if (next === i) return i;
      i = next;
    }
  }

  // True when the word at i (case-insensitive) is not followed by a name character.
  function matchWord(css, i, word) {
    return css.slice(i, i + word.length).toLowerCase() === word && !NAME_CHAR.test(css[i + word.length] || "");
  }

  // Index of the first `end` character at or after `from`, or the end of the text. A backslash
  // escapes the next character.
  function scanTo(css, from, end) {
    let i = from;
    while (i < css.length && css[i] !== end) i += css[i] === "\\" ? 2 : 1;
    return Math.min(i, css.length);
  }

  // Index of the closing quote of the string opening at css[from], or the end of the text.
  const stringEnd = (css, from) => scanTo(css, from + 1, css[from]);

  const skipString = (css, from) => Math.min(stringEnd(css, from) + 1, css.length);

  // Splits a declaration block on top-level semicolons (not inside comments, strings or
  // parentheses); comments become a space. Text between interesting characters is copied as runs.
  function splitDeclarations(text) {
    const out = [];
    let current = "";
    let from = 0;
    let depth = 0;
    let i = 0;
    while (true) {
      DECLARATION_START.lastIndex = i;
      const match = DECLARATION_START.exec(text);
      if (!match) break;
      i = match.index;
      const c = text[i];
      if (c === "/") {
        const next = skipComment(text, i);
        if (next === i) { i++; continue; }
        current += `${text.slice(from, i)} `;
        i = from = next;
      } else if (c === '"' || c === "'") {
        i = skipString(text, i);
      } else if (c === ";" && !depth) {
        out.push(current + text.slice(from, i));
        current = "";
        i = from = i + 1;
      } else {
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        i++;
      }
    }
    out.push(current + text.slice(from));
    return out;
  }

  // Only the first url() of the last src declaration is what a browser would try first.
  function fontFaceEntry(block) {
    let src = "";
    let range = "";
    for (const declaration of splitDeclarations(block)) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim().toLowerCase();
      if (name === "src") src = declaration.slice(colon + 1);
      else if (name === "unicode-range") range = declaration.slice(colon + 1).trim();
    }
    const first = cssResources(src).find((entry) => entry.kind === "url");
    return first ? { value: first.value, kind: "font", range } : null;
  }

  // A small CSS tokenizer: comments and strings are consumed atomically, so url-like text
  // inside unrelated strings never becomes a resource. Returns { value, kind } entries where
  // kind is "import" (@import), "font" (first src url of an @font-face, with its
  // unicode-range) or "url" (any other url()).
  function cssResources(css) {
    const found = [];
    let i = 0;
    // A quoted string at i; its (decoded) value is returned and i moves past it.
    const quoted = () => {
      const end = stringEnd(css, i);
      const value = decodeCss(css.slice(i + 1, end));
      i = Math.min(end + 1, css.length);
      return value;
    };
    // The url( ... ) function whose "(" is at i; i moves past its ")".
    const urlFunction = () => {
      i = skipBlank(css, i + 1);
      let value;
      if (css[i] === "'" || css[i] === '"') value = quoted();
      else {
        const end = scanTo(css, i, ")");
        value = decodeCss(css.slice(i, end).trim());
        i = end;
      }
      const close = css.indexOf(")", i);
      i = close < 0 ? css.length : close + 1;
      return value;
    };
    while (true) {
      RESOURCE_START.lastIndex = i;
      const match = RESOURCE_START.exec(css);
      if (!match) break;
      i = match.index;
      const c = css[i];
      if (c === "/") {
        const next = skipComment(css, i);
        i = next > i ? next : i + 1;
      } else if (c === '"' || c === "'") {
        i = skipString(css, i);
      } else if (c === "@" && matchWord(css, i, "@import")) {
        i = skipBlank(css, i + 7);
        if (css[i] === "'" || css[i] === '"') found.push({ value: quoted(), kind: "import" });
        else if (matchWord(css, i, "url")) {
          i = skipBlank(css, i + 3);
          if (css[i] === "(") found.push({ value: urlFunction(), kind: "import" });
        }
      } else if (c === "@" && matchWord(css, i, "@font-face")) {
        i = skipBlank(css, i + 10);
        if (css[i] !== "{") continue;
        const start = ++i;
        let depth = 1;
        while (depth) {
          BLOCK_START.lastIndex = i;
          const inner = BLOCK_START.exec(css);
          if (!inner) { i = css.length; break; }
          i = inner.index;
          const d = css[i];
          if (d === "/") {
            const next = skipComment(css, i);
            i = next > i ? next : i + 1;
          } else if (d === '"' || d === "'") i = skipString(css, i);
          else {
            depth += d === "{" ? 1 : -1;
            i++;
          }
        }
        const entry = fontFaceEntry(css.slice(start, depth ? i : i - 1));
        if (entry) found.push(entry);
      } else if ((c === "u" || c === "U") && !NAME_CHAR.test(css[i - 1] || "") && matchWord(css, i, "url")) {
        const start = i;
        i = skipBlank(css, i + 3);
        if (css[i] === "(") found.push({ value: urlFunction(), kind: "url" });
        else i = start + 1;
      } else i++;
    }
    return found;
  }

  // Sorted distinct code points of the destination's title and the start of its body text.
  function pageCodepoints(doc) {
    let text = `${doc.title || ""} `;
    if (doc.body) {
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node && text.length < MAX_TEXT_CHARS; node = walker.nextNode()) text += node.data;
    }
    return Uint32Array.from(new Set(Array.from(text.slice(0, MAX_TEXT_CHARS), (character) => character.codePointAt(0)))).sort();
  }

  // True when some code point in the sorted array lies within [low, high].
  function containsBetween(codepoints, low, high) {
    let lo = 0;
    let hi = codepoints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (codepoints[mid] < low) lo = mid + 1;
      else hi = mid;
    }
    return lo < codepoints.length && codepoints[lo] <= high;
  }

  // True when the unicode-range covers at least one character of the page text. Unparsable
  // ranges count as covering, since the face may be needed.
  function rangeCovers(range, codepoints) {
    let parsed = false;
    for (const part of range.split(",")) {
      const match = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part);
      if (!match) continue;
      parsed = true;
      let low;
      let high;
      if (match[1].includes("?")) {
        low = parseInt(match[1].replace(/\?/g, "0"), 16);
        high = parseInt(match[1].replace(/\?/g, "f"), 16);
      } else {
        low = parseInt(match[1], 16);
        high = match[2] ? parseInt(match[2], 16) : low;
      }
      if (containsBetween(codepoints, low, high)) return true;
    }
    return !parsed;
  }

  function parseSrcset(srcset) {
    const out = [];
    const text = srcset || "";
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i >= text.length) break;
      const start = i;
      while (i < text.length && !/\s/.test(text[i])) i++;
      let url = text.slice(start, i);
      let desc = "";
      if (url.endsWith(",")) url = url.replace(/,+$/, "");
      else {
        const descStart = i;
        while (i < text.length && text[i] !== ",") i++;
        desc = text.slice(descStart, i).trim();
      }
      const match = /^(\d+(?:\.\d+)?|\.\d+)([wx])$/i.exec(desc);
      out.push({
        url, desc,
        w: match && match[2].toLowerCase() === "w" ? Number(match[1]) : 0,
        x: match && match[2].toLowerCase() === "x" ? Number(match[1]) : 1,
      });
    }
    return out;
  }

  // What one page job reads from the browser: the viewport, the pixel ratio and media query
  // results, each looked up once.
  function pageEnvironment() {
    const answers = new Map();
    return {
      viewport: document.documentElement?.clientWidth || globalThis.innerWidth || 0,
      ratio: globalThis.devicePixelRatio || 1,
      matches(media) {
        if (!media || typeof globalThis.matchMedia !== "function") return true;
        if (!answers.has(media)) {
          let matched = false;
          try { matched = globalThis.matchMedia(media).matches; } catch { /* an unparsable query does not match */ }
          answers.set(media, matched);
        }
        return answers.get(media);
      },
    };
  }

  // First sizes entry whose media condition matches, else the last entry. Only px and vw
  // lengths are understood (calc() and friends fall back to 100vw).
  function slotWidth(sizes, environment) {
    const entries = [];
    let depth = 0;
    let start = 0;
    const text = sizes || "";
    for (let i = 0; i <= text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth = Math.max(0, depth - 1);
      else if ((text[i] === "," && !depth) || i === text.length) {
        if (text.slice(start, i).trim()) entries.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    let length = "100vw";
    for (let index = 0; index < entries.length; index++) {
      const withMedia = /^(.*\))\s+([^\s()]+)$/.exec(entries[index]);
      const media = withMedia ? withMedia[1] : "";
      const candidate = withMedia ? withMedia[2] : entries[index];
      if (environment.matches(media) || index === entries.length - 1) { length = candidate; break; }
    }
    const parsed = /^(\d*\.?\d+)(px|vw)$/i.exec(length) || [null, "100", "vw"];
    return parsed[2].toLowerCase() === "px" ? Number(parsed[1]) : environment.viewport * Number(parsed[1]) / 100;
  }

  function pickCandidate(candidates, sizes, environment) {
    if (!candidates.length) return null;
    if (candidates.some((candidate) => candidate.w)) {
      const need = slotWidth(sizes, environment) * environment.ratio;
      const byWidth = candidates.filter((candidate) => candidate.w).sort((a, b) => a.w - b.w);
      return byWidth.find((candidate) => candidate.w >= need) || byWidth[byWidth.length - 1];
    }
    const byDensity = [...candidates].sort((a, b) => a.x - b.x);
    return byDensity.find((candidate) => candidate.x >= environment.ratio) || byDensity[byDensity.length - 1];
  }

  // Selects among the permitted image URLs; `permitted` is warmPage's safety filter.
  function chooseImage(src, srcset, sizes, base, permitted, environment) {
    const candidates = parseSrcset(srcset).map((candidate) => ({ ...candidate, url: permitted(candidate.url, base) }))
      .filter((candidate) => candidate.url);
    const fallback = permitted(src, base);
    if (!hintStrategy.browserChoosesSrcset) {
      const url = pickCandidate(candidates, sizes, environment)?.url || fallback;
      return url ? { url: url.href } : null;
    }
    const first = fallback || candidates[0]?.url;
    if (!first) return null;
    return {
      url: first.href,
      srcset: candidates.map((candidate) => `${candidate.url.href}${candidate.desc ? ` ${candidate.desc}` : ""}`).join(", "),
      sizes,
    };
  }

  // Only attributes of the element that actually requests the asset are ever copied to a hint.
  function attrsOf(node) {
    return {
      integrity: node.getAttribute("integrity") || "",
      crossorigin: node.getAttribute("crossorigin"),
      referrerpolicy: node.getAttribute("referrerpolicy") || "",
      media: node.getAttribute("media") || "",
      type: node.getAttribute("type") || "",
    };
  }

  function crossOriginFor(kind, crossorigin) {
    // Fonts and module scripts are always CORS requests; others only mirror the element.
    if (crossorigin === "use-credentials") return "use-credentials";
    return crossorigin != null || kind === "font" || kind === "module" ? "anonymous" : "";
  }

  // Returns { loaded } (a promise that settles when the hint loaded, failed or timed out), or
  // null when a budget refuses it. The budget is reserved synchronously.
  function makeHint(url, kind, attributes, pageHints) {
    const cross = crossOriginFor(kind, attributes.crossorigin);
    const signature = [kind, url.href, cross, ...HINT_ATTRS.map((name) => attributes[name] || "")].join("\u0000");
    if (state.hints.has(signature)) return { loaded: state.hints.get(signature) };
    if (state.hints.size >= MAX_ASSETS || pageHints.size >= MAX_PER_PAGE) return null;
    const link = document.createElement("link");
    link.rel = hintStrategy.rel(kind);
    if (link.rel !== "modulepreload") link.setAttribute("as", kind === "module" ? "script" : kind);
    link.href = url.href;
    if (hintStrategy.lowPriority) link.fetchPriority = "low";
    for (const name of HINT_ATTRS) {
      if (attributes[name]) link.setAttribute(name, attributes[name]);
    }
    const suppliedType = attributes.type || "";
    let hintType = SAFE_HINT_TYPE.test(suppliedType) ? suppliedType : "";
    if (kind === "font" && !hintType) {
      const ext = url.pathname.split(".").pop().toLowerCase();
      hintType = ({ woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" })[ext] || "";
    }
    if (hintType) link.type = hintType;
    if (cross) link.crossOrigin = cross;
    link.addEventListener("error", () => console.debug("[snappy pageload] resource hint failed", link.href), { once: true });
    const loaded = hintStrategy.place(() => {
      (document.head || document.documentElement).appendChild(link);
      return linkSettled(link, HINT_TIMEOUT_MS);
    });
    state.hints.set(signature, loaded);
    pageHints.add(signature);
    return { loaded };
  }

  function isLazyOrTiny(img) {
    if ((img.getAttribute("loading") || "").trim().toLowerCase() === "lazy") return true;
    return ["width", "height"].some((name) => {
      const value = parseInt(img.getAttribute(name), 10);
      return Number.isFinite(value) && value <= 2;
    });
  }

  function qualifyingSource(source, environment) {
    const type = (source.getAttribute("type") || "").split(";")[0].trim();
    return (!type || SUPPORTED_IMAGE_TYPE.test(type)) && environment.matches(source.getAttribute("media"));
  }

  // The hint kind a <link> declares, or "" when it requests nothing worth warming.
  function linkKind(node) {
    const rels = (node.getAttribute("rel") || "").toLowerCase().split(/\s+/);
    if (rels.includes("stylesheet")) return "style";
    if (rels.includes("modulepreload")) return "module";
    if (!rels.includes("preload")) return "";
    const as = (node.getAttribute("as") || "").toLowerCase();
    return /^(font|style|script|image)$/.test(as) ? as : "";
  }

  // Lower numbers are hinted first (and so win the page's budgets).
  function priority(node) {
    if (node.localName === "link") return { style: 0, module: 1, script: 1, font: 2 }[linkKind(node)] ?? 4;
    if (node.localName === "script") return (node.getAttribute("type") || "").toLowerCase() === "module" ? 1 : 3;
    if (node.localName === "style" || node.hasAttribute("style")) return 0;
    return 5;
  }

  function warmPage(input, { after } = {}) {
    if (navigator.connection?.saveData) return idle();
    const pageUrl = safeUrl(input, location.href);
    if (pageUrl?.origin !== location.origin) return idle();
    const pageKey = pageUrl.href;
    if (state.pages.has(pageKey)) return state.pages.get(pageKey);
    if (state.pages.size >= MAX_PAGES) return idle();
    let deadline;
    const pageAssets = new Set();
    const pageHints = new Set();
    let images = 0;
    let destination = null;
    let codepoints = null;
    let pending = 0;
    let resolveRun;
    const run = new Promise((resolve) => { resolveRun = resolve; });
    // Resolves with counts for this page only, not running totals, once nothing is in flight.
    const track = (promise) => {
      pending++;
      void promise.catch((error) => console.debug("[snappy pageload] resource warm failed", error))
        .finally(() => { if (--pending === 0) resolveRun({ pages: 1, assets: pageAssets.size }); });
    };
    // The URL when it may be warmed: safe, and not a state-changing or tracking link.
    const permitted = (raw, base) => {
      const url = safeUrl(raw, base);
      return url && !isUnsafePath(url) && !TRACKER_ASSET.test(decodedPathAndQuery(url)) ? url : null;
    };
    const addAsset = (raw, base, kind, attributes = {}, depth = 0) => {
      if (Date.now() >= deadline) return;
      const url = permitted(raw, base);
      if (!url) return;
      const key = url.href;
      const isNew = !pageAssets.has(key);
      if (isNew) {
        if (pageAssets.size >= MAX_PER_PAGE) return;
        if (kind === "image" && images >= MAX_IMAGES) return;
      }
      const hint = makeHint(url, kind, attributes, pageHints);
      if (!hint) return;
      if (isNew) {
        pageAssets.add(key);
        if (kind === "image") images++;
      }
      if (kind !== "style" || depth > MAX_DEPTH || url.origin !== location.origin || state.css.has(key)) {
        track(hint.loaded);
        return;
      }
      state.css.add(key);
      // Parse only after the hint has loaded so the stylesheet is not downloaded twice.
      track(hint.loaded.then(() => boundedFetch(url, MAX_CSS_BYTES, "text/css", deadline, "force-cache")).then((resource) => {
        if (resource) addCssResources(resource.text, resource.url.href, depth, false);
      }));
    };
    // Stylesheets and <style> contribute @imports and fonts only: background images depend on
    // selectors and media queries. A style="" attribute applies to its own element, so its
    // url()s are images.
    const addCssResources = (css, base, depth, inlineStyle) => {
      for (const entry of cssResources(css)) {
        if (entry.kind === "import") addAsset(entry.value, base, "style", {}, depth + 1);
        else if (entry.kind === "font") {
          // The page text is only needed for faces restricted to a unicode-range.
          if (!entry.range || rangeCovers(entry.range, codepoints ??= pageCodepoints(destination))) {
            addAsset(entry.value, base, "font");
          }
        } else if (inlineStyle) addAsset(entry.value, base, "image");
      }
    };
    // In Firefox the caller already started a native prefetch for the document; wait for it,
    // then read the HTML from the HTTP cache. Without it (Safari) fetch normally.
    const ready = Promise.resolve(after).catch(() => {});
    const cache = after ? "force-cache" : "default";
    const pageJob = ready.then(() => {
      deadline = Date.now() + TIMEOUT_MS;
      return boundedFetch(pageUrl, MAX_PAGE_BYTES, "text/html", deadline, cache);
    }).then((resource) => {
      if (!resource) return;
      // DOMParser documents have scripting disabled and load nothing. That also turns
      // <noscript> content into real elements, so those descendants are excluded below.
      const doc = new DOMParser().parseFromString(resource.text, "text/html");
      destination = doc;
      const environment = pageEnvironment();
      const base = safeUrl(doc.querySelector("base[href]")?.getAttribute("href"), resource.url.href)?.href ?? resource.url.href;
      const addImage = (src, srcset, sizes, attributes) => {
        const choice = chooseImage(src, srcset, sizes, base, permitted, environment);
        if (choice) addAsset(choice.url, base, "image", { ...attributes, integrity: "", imagesrcset: choice.srcset, imagesizes: choice.sizes });
      };
      // Bucket by priority; document order is kept within a bucket.
      const buckets = [[], [], [], [], [], []];
      for (const node of doc.querySelectorAll("link[rel],script[src],img,picture,video[poster],style,[style]")) {
        buckets[priority(node)].push(node);
      }
      for (const node of buckets.flat()) {
        if (Date.now() >= deadline) break;
        if (node.closest("noscript")) continue;
        const tag = node.localName;
        if (tag === "style") {
          addCssResources(node.textContent || "", base, 0, false);
          continue;
        }
        if (node.hasAttribute("style")) addCssResources(node.getAttribute("style") || "", base, 0, true);
        if (tag === "link") {
          const kind = linkKind(node);
          if (kind === "image") addImage(node.getAttribute("href"), node.getAttribute("imagesrcset"), node.getAttribute("imagesizes"), attrsOf(node));
          else if (kind) addAsset(node.getAttribute("href"), base, kind, attrsOf(node));
        } else if (tag === "script") {
          if (node.hasAttribute("nomodule")) continue;
          const type = (node.getAttribute("type") || "").toLowerCase().split(";")[0].trim();
          if (!type || type === "module" || /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(type)) {
            addAsset(node.getAttribute("src"), base, type === "module" ? "module" : "script", attrsOf(node));
          }
        } else if (tag === "img") {
          // Images inside <picture> are handled with the picture.
          if (node.parentElement?.localName === "picture" || isLazyOrTiny(node)) continue;
          addImage(node.getAttribute("src"), node.getAttribute("srcset"), node.getAttribute("sizes"), attrsOf(node));
        } else if (tag === "picture") {
          const img = node.querySelector("img");
          if (img && isLazyOrTiny(img)) continue;
          const source = [...node.children].find((child) => child.localName === "source" && qualifyingSource(child, environment));
          const attributes = img ? attrsOf(img) : {};
          // The first usable source wins, and the fallback <img> is skipped with the rest.
          if (source) addImage(null, source.getAttribute("srcset"), source.getAttribute("sizes"), attributes);
          else if (img) addImage(img.getAttribute("src"), img.getAttribute("srcset"), img.getAttribute("sizes"), attributes);
        } else if (tag === "video") addAsset(node.getAttribute("poster"), base, "image", attrsOf(node));
      }
    });
    track(pageJob);
    state.pages.set(pageKey, run);
    return run;
  }

  globalThis.fasterPageloadWarmPage = warmPage;
})();
