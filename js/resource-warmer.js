"use strict";

// Discover destination-page resources without executing or attaching destination markup.
(() => {
  if (globalThis.fasterPageloadResourceWarmerLoaded) return;
  globalThis.fasterPageloadResourceWarmerLoaded = true;

  const MAX_PAGE_BYTES = 2 * 1024 * 1024;
  const MAX_CSS_BYTES = 512 * 1024;
  const MAX_DEPTH = 2;
  const MAX_PAGES = 30;
  const MAX_ASSETS = 100;
  const MAX_PER_PAGE = 20;
  const TIMEOUT_MS = 10_000;
  const shared = { active: 0, tasks: [] };
  const documents = new WeakMap();

  function stateForDocument() {
    let state = documents.get(document);
    if (!state) {
      state = { pages: new Map(), assets: new Set(), hints: new Set(), css: new Set(), pageAssets: new Map(), pageRequests: 0 };
      documents.set(document, state);
    }
    return state;
  }

  function schedule(task) {
    return new Promise((resolve) => {
      shared.tasks.push(async () => {
        try { resolve(await task()); } catch (error) { resolve(undefined); }
      });
      pump();
    });
  }

  function pump() {
    while (shared.active < 4 && shared.tasks.length) {
      const task = shared.tasks.shift();
      shared.active++;
      void task().finally(() => { shared.active--; pump(); });
    }
  }

  function safeUrl(value, base, pageOrigin, pageProtocol) {
    if (!value || /^\s*(?:#|(?:data|blob|javascript|mailto|tel):)/i.test(value)) return null;
    let url;
    try { url = new URL(value, base); } catch { return null; }
    url.hash = "";
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    if (pageProtocol === "https:" && url.protocol === "http:") return null;
    return url;
  }

  function allowedPage(url) {
    return url && url.origin === location.origin && !url.username && !url.password &&
      /^https?:$/.test(url.protocol) && !(location.protocol === "https:" && url.protocol === "http:");
  }

  function boundedFetch(url, limit, contentType, deadline, expectedOrigin) {
    return schedule(async () => {
      if (Date.now() >= deadline) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      try {
        const response = await fetch(url.href, {
          mode: "same-origin", credentials: "same-origin", cache: "default", redirect: "follow",
          signal: controller.signal,
        });
        let finalUrl;
        try { finalUrl = new URL(response.url || url.href); } catch { await response.body?.cancel(); return null; }
        if (!/^https?:$/.test(finalUrl.protocol) || finalUrl.origin !== expectedOrigin || finalUrl.username || finalUrl.password) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok || (contentType && !(response.headers.get("content-type") || "").toLowerCase().includes(contentType))) {
          await response.body?.cancel();
          return null;
        }
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > limit) { await response.body?.cancel(); return null; }
        if (!response.body?.getReader) {
          const text = await response.text();
          return text.length <= limit ? { text, url: finalUrl.href } : null;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); return null; }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { text: new TextDecoder().decode(bytes), url: finalUrl.href };
      } finally { clearTimeout(timer); }
    });
  }

  function decodeCss(value) {
    return value.replace(/\\([\da-f]{1,6}\s?|\r\n|\n|\r|.)/gi, (_, escape) => {
      if (/^[\da-f]/i.test(escape)) {
        const code = parseInt(escape.trim(), 16);
        return !code || code > 0x10ffff ? "\uFFFD" : String.fromCodePoint(code);
      }
      return /^[\r\n]/.test(escape) ? "" : escape;
    });
  }

  // A small CSS tokenizer: comments and strings are consumed atomically, so url-like text
  // inside unrelated strings never becomes a resource. Returns [url, isImport] pairs.
  function cssResources(css) {
    const found = [];
    let i = 0;
    const whitespace = () => { while (i < css.length && /\s/.test(css[i])) i++; };
    const comment = () => {
      if (css[i] === "/" && css[i + 1] === "*") {
        i += 2;
        while (i < css.length && !(css[i] === "*" && css[i + 1] === "/")) i++;
        i = Math.min(css.length, i + 2);
        return true;
      }
      return false;
    };
    const quoted = () => {
      const quote = css[i++];
      let value = "";
      while (i < css.length && css[i] !== quote) {
        if (css[i] === "\\" && i + 1 < css.length) value += css[i++];
        value += css[i++];
      }
      if (css[i] === quote) i++;
      return decodeCss(value);
    };
    const urlFunction = () => {
      // Caller leaves i at the opening parenthesis.
      i++;
      whitespace(); while (comment()) whitespace();
      let value = "";
      if (css[i] === "'" || css[i] === '"') value = quoted();
      else {
        while (i < css.length && css[i] !== ")") {
          if (css[i] === "\\" && i + 1 < css.length) value += css[i++];
          value += css[i++];
        }
        value = decodeCss(value.trim());
      }
      while (i < css.length && css[i] !== ")") i++;
      if (css[i] === ")") i++;
      return value;
    };
    while (i < css.length) {
      if (comment()) continue;
      if (css[i] === "'" || css[i] === '"') { quoted(); continue; }
      if (css[i] === "@" && css.slice(i, i + 7).toLowerCase() === "@import" && !/[\w-]/.test(css[i + 7] || "")) {
        i += 7; whitespace(); while (comment()) whitespace();
        if (css[i] === "'" || css[i] === '"') found.push([quoted(), true]);
        else if (css.slice(i, i + 3).toLowerCase() === "url" && !/[\w-]/.test(css[i + 3] || "")) {
          i += 3; whitespace(); while (comment()) whitespace();
          if (css[i] === "(") found.push([urlFunction(), true]);
        }
        continue;
      }
      if (css.slice(i, i + 3).toLowerCase() === "url" && !/[\w-]/.test(css[i - 1] || "") && !/[\w-]/.test(css[i + 3] || "")) {
        let j = i + 3;
        while (j < css.length) {
          if (/\s/.test(css[j])) { j++; continue; }
          if (css[j] === "/" && css[j + 1] === "*") {
            j += 2;
            while (j < css.length && !(css[j] === "*" && css[j + 1] === "/")) j++;
            j = Math.min(css.length, j + 2);
            continue;
          }
          break;
        }
        if (css[j] === "(") { i = j; found.push([urlFunction(), false]); continue; }
      }
      i++;
    }
    return found;
  }

  function makeHint(url, kind, source, attributes = {}, pageHints) {
    let cross = attributes.crossorigin ?? source?.getAttribute?.("crossorigin");
    if (kind === "font" && !cross) cross = "anonymous";
    if (kind === "module" && cross == null) cross = "anonymous";
    const effectiveCross = cross === "use-credentials" ? "use-credentials" : cross != null || kind === "font" || kind === "module" ? "anonymous" : "";
    const integrity = attributes.integrity || source?.getAttribute?.("integrity") || "";
    const referrer = attributes.referrerpolicy || source?.getAttribute?.("referrerpolicy") || "";
    const signature = [kind, url.href, effectiveCross, integrity, referrer,
      attributes.imagesrcset || "", attributes.imagesizes || "", attributes.media || source?.getAttribute?.("media") || ""].join("\u0000");
    const state = stateForDocument();
    if (state.hints.has(signature)) return true;
    if (state.hints.size >= MAX_ASSETS || pageHints.size >= MAX_PER_PAGE) return false;
    state.hints.add(signature);
    pageHints.add(signature);
    const link = document.createElement("link");
    link.rel = kind === "module" ? "modulepreload" : "preload";
    if (link.rel === "preload") { link.as = kind; link.setAttribute("as", kind); }
    link.href = url.href;
    link.fetchPriority = "low";
    for (const name of ["integrity", "referrerpolicy", "media"]) {
      const value = attributes[name] || source?.getAttribute?.(name);
      if (value) link.setAttribute(name, value);
    }
    const suppliedType = attributes.type || source?.getAttribute?.("type") || "";
    const safeType = /^(?:text\/css|(?:text|application)\/(?:javascript|ecmascript)|image\/(?:avif|gif|jpeg|png|svg\+xml|webp)|font\/(?:woff|woff2|ttf|otf))$/i;
    let hintType = safeType.test(suppliedType) ? suppliedType : "";
    if (kind === "font" && !hintType) {
      const ext = url.pathname.split(".").pop().toLowerCase();
      hintType = ({ woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" })[ext] || "";
    }
    if (hintType) link.type = hintType;
    if (cross === "use-credentials") link.crossOrigin = "use-credentials";
    else if (cross != null || kind === "font" || kind === "module") link.crossOrigin = "anonymous";
    if (attributes.imagesrcset) link.setAttribute("imagesrcset", attributes.imagesrcset);
    if (attributes.imagesizes) link.setAttribute("imagesizes", attributes.imagesizes);
    link.addEventListener("error", () => console.debug("[snappy pageload] resource hint failed", url.href), { once: true });
    (document.head || document.documentElement).appendChild(link);
    return true;
  }

  function srcsetFirst(srcset) {
    if (!srcset) return "";
    return srcset.split(",").map((item) => item.trim().split(/\s+/)[0]).find(Boolean) || "";
  }

  function normalizedSrcset(srcset, base, protocol) {
    return (srcset || "").split(",").map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = safeUrl(parts.shift(), base, location.origin, protocol);
      return url ? `${url.href}${parts.length ? ` ${parts.join(" ")}` : ""}` : "";
    }).filter(Boolean).join(", ");
  }

  function assetKind(url, isImport) {
    if (isImport) return "style";
    return /\.(?:woff2?|ttf|otf)(?:$|\?)/i.test(url) ? "font" : "image";
  }

  function warmPage(input, { includeAssets = true } = {}) {
    const state = stateForDocument();
    if (navigator.connection?.saveData) return Promise.resolve({ pages: 0, assets: 0 });
    const pageUrl = safeUrl(input, location.href, location.origin, location.protocol);
    if (!allowedPage(pageUrl)) return Promise.resolve({ pages: 0, assets: 0 });
    const pageKey = pageUrl.href;
    if (state.pages.has(pageKey)) return state.pages.get(pageKey);
    if (state.pageRequests >= MAX_PAGES) return Promise.resolve({ pages: 0, assets: 0 });
    state.pageRequests++;
    const deadline = Date.now() + TIMEOUT_MS;
    const pageAssets = new Set();
    const pageHints = new Set();
    state.pageAssets.set(pageKey, pageAssets);
    let pending = 0;
    let finished = false;
    let resolveRun;
    const run = new Promise((resolve) => { resolveRun = resolve; });
    const summary = () => ({ pages: state.pageRequests, assets: state.assets.size });
    const completeIfIdle = () => {
      if (finished && pending === 0) resolveRun(summary());
    };
    const track = (promise) => {
      pending++;
      void promise.catch((error) => console.debug("[snappy pageload] resource warm failed", error))
        .finally(() => { pending--; completeIfIdle(); });
    };
    const addAsset = (raw, base, kind, source, depth = 0, cssStack = new Set(), extra = {}) => {
      if (Date.now() >= deadline) return;
      const url = safeUrl(raw, base, location.origin, pageUrl.protocol);
      if (!url) return;
      const key = url.href;
      if (!pageAssets.has(key)) {
        if (pageAssets.size >= MAX_PER_PAGE || (!state.assets.has(key) && state.assets.size >= MAX_ASSETS)) return;
        pageAssets.add(key);
        if (!state.assets.has(key)) state.assets.add(key);
      }
      if (!makeHint(url, kind, source, extra, pageHints)) return;
      if (kind !== "style" || depth > MAX_DEPTH || url.origin !== pageUrl.origin || cssStack.has(key) || state.css.has(key)) return;
      state.css.add(key);
      const nextStack = new Set(cssStack); nextStack.add(key);
      track(boundedFetch(url, MAX_CSS_BYTES, "text/css", deadline, pageUrl.origin).then((resource) => {
        if (!resource) return;
        for (const [value, isImport] of cssResources(resource.text)) {
          const child = safeUrl(value, resource.url || url.href, location.origin, pageUrl.protocol);
          if (!child) continue;
          addAsset(child.href, resource.url || url.href, assetKind(child.href, isImport), null, isImport ? depth + 1 : depth, nextStack);
        }
      }));
    };
    const pageJob = boundedFetch(pageUrl, MAX_PAGE_BYTES, "text/html", deadline, pageUrl.origin).then((resource) => {
      if (!resource) return;
      if (includeAssets) {
        const responseUrl = safeUrl(resource.url || pageUrl.href, pageUrl.href, location.origin, pageUrl.protocol);
        if (!allowedPage(responseUrl)) return;
        const template = document.createElement("template");
        template.innerHTML = resource.text;
        let base = responseUrl.href;
        const baseElement = template.content.querySelector("base[href]");
        if (baseElement) {
          const candidate = safeUrl(baseElement.getAttribute("href"), base, location.origin, responseUrl.protocol);
          if (candidate) base = candidate.href;
        }
        const root = template.content;
        const nodes = [...root.querySelectorAll("link[rel],script[src],img[src],img[srcset],source[srcset],video[poster],style,[style]")];
        const priority = (node) => {
          if (node.localName === "link") {
            const rels = (node.getAttribute("rel") || "").toLowerCase().split(/\s+/);
            if (rels.includes("stylesheet")) return 0;
            if (rels.includes("modulepreload")) return 1;
            const as = (node.getAttribute("as") || "").toLowerCase();
            if (rels.includes("preload") && as === "style") return 0;
            if (rels.includes("preload") && as === "script") return 1;
            if (rels.includes("preload") && as === "font") return 2;
            return 4;
          }
          if (node.localName === "script") return (node.getAttribute("type") || "").toLowerCase() === "module" ? 1 : 3;
          if (node.localName === "style" || node.hasAttribute("style")) return 0;
          return 5;
        };
        nodes.sort((a, b) => priority(a) - priority(b));
        for (const node of nodes) {
          const tag = node.localName;
          if (tag === "style" || node.hasAttribute("style")) {
            const css = tag === "style" ? node.textContent || "" : node.getAttribute("style") || "";
            for (const [value, isImport] of cssResources(css)) addAsset(value, base, assetKind(value, isImport), node);
            if (tag === "style") continue;
          }
          if (tag === "link") {
            const rels = (node.getAttribute("rel") || "").toLowerCase().split(/\s+/);
            const as = (node.getAttribute("as") || "").toLowerCase();
            if (rels.includes("stylesheet")) addAsset(node.getAttribute("href"), base, "style", node);
            else if (rels.includes("modulepreload")) addAsset(node.getAttribute("href"), base, "module", node);
            else if (rels.includes("preload") && /^(font|style|script|image)$/.test(as)) addAsset(node.getAttribute("href"), base, as, node, 0, new Set(), {
              imagesrcset: as === "image" ? normalizedSrcset(node.getAttribute("imagesrcset"), base, responseUrl.protocol) : undefined,
              imagesizes: node.getAttribute("imagesizes") || undefined,
            });
            continue;
          }
          if (tag === "script") {
            const type = (node.getAttribute("type") || "").toLowerCase().split(";")[0].trim();
            if (!type || type === "module" || /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(type)) {
              addAsset(node.getAttribute("src"), base, type === "module" ? "module" : "script", node);
            }
          } else if (tag === "img") {
            const srcset = normalizedSrcset(node.getAttribute("srcset"), base, responseUrl.protocol);
            const chosen = node.getAttribute("src") || srcsetFirst(srcset);
            const url = safeUrl(chosen, base, location.origin, responseUrl.protocol);
            if (url) addAsset(url.href, base, "image", node, 0, new Set(), {
              imagesrcset: srcset || undefined, imagesizes: node.getAttribute("sizes") || undefined,
            });
          } else if (tag === "source") {
            if (node.parentElement?.localName === "picture" && (!node.getAttribute("type") || node.getAttribute("type").startsWith("image/"))) {
              const srcset = normalizedSrcset(node.getAttribute("srcset"), base, responseUrl.protocol);
              const url = safeUrl(srcsetFirst(srcset), base, location.origin, responseUrl.protocol);
              if (url) addAsset(url.href, base, "image", node, 0, new Set(), {
                imagesrcset: srcset, imagesizes: node.getAttribute("sizes") || undefined,
              });
            }
          } else if (tag === "video") addAsset(node.getAttribute("poster"), base, "image", node);
        }
      }
    });
    track(pageJob);
    finished = true;
    completeIfIdle();
    state.pages.set(pageKey, run);
    return run;
  }

  globalThis.fasterPageloadWarmPage = warmPage;
})();
