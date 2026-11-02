"use strict";

// Prefetches same-origin pages the user is about to open: on hover, touch and mousedown, and
// (unless disabled) links as they scroll into view, including their scripts, styles and images.
// Approach based on instant.page by Alexandre Dieulot (https://instant.page/).
(() => {
  // A page can receive this script twice while the background script swaps registrations.
  // The flag lives in the extension's content-script scope, not on the page.
  if (globalThis.fasterPageloadPreloadLoaded) return;
  globalThis.fasterPageloadPreloadLoaded = true;

  const HOVER_DELAY_MS = 65;
  // Touch devices fire a synthetic mouseover after touchstart; ignore it.
  const TOUCH_MOUSEOVER_GAP_MS = 1111;
  // The warmer waits this long for the browser's own prefetch before reading the HTML itself.
  const PREFETCH_WAIT_MS = 5000;
  // Upper bound so link-heavy pages do not flood the server.
  const MAX_VIEWPORT_PRELOADS = 30;
  // GET links that commonly change state on the server must never be fetched speculatively.
  // False positives only cost a missed prefetch, so this errs on the side of skipping.
  const UNSAFE_LINK = new RegExp(
    [
      "(log|sign)[-_ ]?(out|off)",
      "delete|destroy|remove|revoke|cancel|disconnect",
      "subscribe|\\bfollow\\b|unfollow|vote|\\blike\\b|unlike",
      "approve|confirm|accept|reject|archive|toggle|token",
      "mark[-_]?(as[-_]?)?(read|unread|seen|done)",
      "add[-_]?to[-_]?(cart|basket|bag)",
    ].join("|"),
    "i"
  );
  // Links in comments and other user-generated content are written by third parties, not the
  // site, so they are excluded from automatic preloading.
  const USER_CONTENT = '#comments, .comments, .comment, [itemprop~="comment"]';

  const BLACKLIST_HOST = /^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

  const prefetchSupported = document.createElement("link").relList?.supports?.("prefetch") === true;
  const warmPage = globalThis.fasterPageloadWarmPage;
  if ((!prefetchSupported && !warmPage) || !document.body) return;

  const preloaded = new Set();
  let preloadAssets = true;
  let lastTouchAt = -Infinity;
  let hoverTimer;

  // Same semantics as toExcludeMatches in background.js. Safari may ignore excludeMatches when
  // registering scripts (Apple FB16590857), so the script checks again itself.
  function isBlacklisted(blacklistSites) {
    const host = location.hostname.toLowerCase();
    return String(blacklistSites ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => BLACKLIST_HOST.test(entry))
      .some((entry) => {
        if (!entry.startsWith("*.")) return host === entry;
        const base = entry.slice(2);
        return host === base || host.endsWith(`.${base}`);
      });
  }

  function isPreloadable(anchor) {
    if (!anchor || !anchor.href || anchor.hasAttribute("download")) return false;
    if ("noInstant" in anchor.dataset) return false;
    if (anchor.protocol !== "http:" && anchor.protocol !== "https:") return false;
    if (anchor.username || anchor.password) return false;
    // Firefox partitions its cache by top-level site, so cross-origin prefetches are never reused.
    if (anchor.origin !== location.origin) return false;
    // The current page itself, with or without a fragment.
    if (anchor.pathname + anchor.search === location.pathname + location.search) return false;
    return !UNSAFE_LINK.test(decodedPathAndQuery(anchor));
  }

  // Automatic preloads skip query strings (where action links often carry their
  // parameters) and links from user-generated content.
  function isViewportPreloadable(anchor) {
    if (!isPreloadable(anchor) || anchor.search) return false;
    if (anchor.relList.contains("ugc") || anchor.relList.contains("nofollow")) return false;
    return !anchor.closest(USER_CONTENT);
  }

  function decodedPathAndQuery(anchor) {
    const raw = anchor.pathname + anchor.search;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function withoutHash(url) {
    const target = new URL(url);
    target.hash = "";
    return target.href;
  }

  function addPrefetchLink(url) {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url;
    (document.head || document.documentElement).appendChild(link);
    console.debug("[snappy pageload] prefetch", url);
    return link;
  }

  // Resolves when the browser has finished (or failed) the prefetch, or after a timeout, so the
  // warmer can read the document from the HTTP cache instead of requesting it again.
  function prefetchSettled(link) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, PREFETCH_WAIT_MS);
      function done() {
        clearTimeout(timer);
        link.removeEventListener("load", done);
        link.removeEventListener("error", done);
        resolve();
      }
      link.addEventListener("load", done);
      link.addEventListener("error", done);
    });
  }

  // Hover, touch and mousedown: the user signalled intent, so only the document is prefetched.
  // Safari does not reuse a fetch()-warmed document, so without rel=prefetch there is nothing to do.
  function prefetchDocument(url) {
    if (!prefetchSupported) return;
    url = withoutHash(url);
    if (preloaded.has(url)) return;
    preloaded.add(url);
    addPrefetchLink(url);
  }

  function preloadVisible(url) {
    url = withoutHash(url);
    if (preloaded.has(url)) return;
    const warm = preloadAssets && warmPage;
    // Without rel=prefetch (Safari) the HTML alone is never reused, only its assets are.
    if (!prefetchSupported && !warm) return;
    preloaded.add(url);
    let after;
    if (prefetchSupported) {
      const link = addPrefetchLink(url);
      if (warm) after = prefetchSettled(link);
    }
    if (!warm) return;
    Promise.resolve()
      .then(() => (after ? warmPage(url, { after }) : warmPage(url)))
      .catch((error) => console.debug("[snappy pageload] Could not warm visible page", url, error));
  }

  function anchorFrom(event) {
    return event.target instanceof Element ? event.target.closest("a") : null;
  }

  function cancelHover(event) {
    if (event.relatedTarget && anchorFrom(event) === event.relatedTarget.closest?.("a")) return;
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
  }

  function listenForIntent() {
    if (!prefetchSupported) return;
    const listenerOptions = { capture: true, passive: true };

    document.addEventListener(
      "touchstart",
      (event) => {
        lastTouchAt = performance.now();
        const anchor = anchorFrom(event);
        if (isPreloadable(anchor)) prefetchDocument(anchor.href);
      },
      listenerOptions
    );

    document.addEventListener(
      "mouseover",
      (event) => {
        if (performance.now() - lastTouchAt < TOUCH_MOUSEOVER_GAP_MS) return;
        const anchor = anchorFrom(event);
        if (!isPreloadable(anchor) || preloaded.has(withoutHash(anchor.href))) return;
        // Same function reference each time, so repeated hovers don't stack listeners.
        anchor.addEventListener("mouseout", cancelHover, { passive: true });
        clearTimeout(hoverTimer);
        // Fetch exactly the URL that was validated, and only if the link still points there: a
        // menu or SPA (or a <base href> change) may retarget the link during the delay.
        const url = anchor.href;
        hoverTimer = setTimeout(() => {
          hoverTimer = undefined;
          if (anchor.isConnected && anchor.href === url && isPreloadable(anchor)) prefetchDocument(url);
        }, HOVER_DELAY_MS);
      },
      listenerOptions
    );

    // Keyboard and fast clicks that never produced a hover still get a head start.
    document.addEventListener(
      "mousedown",
      (event) => {
        const anchor = anchorFrom(event);
        if (event.button === 0 && isPreloadable(anchor)) prefetchDocument(anchor.href);
      },
      listenerOptions
    );
  }

  function preloadVisibleLinks() {
    if (navigator.connection?.saveData) return;
    let domObserver;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (preloaded.size >= MAX_VIEWPORT_PRELOADS) {
          observer.disconnect();
          domObserver.disconnect();
          return;
        }
        observer.unobserve(entry.target);
        // Re-check: the page may have changed the link since it was observed.
        if (isViewportPreloadable(entry.target)) preloadVisible(entry.target.href);
      }
    });

    function watchLinksIn(root) {
      const anchors = root.matches?.("a[href]") ? [root] : root.querySelectorAll("a[href]");
      for (const anchor of anchors) {
        if (isViewportPreloadable(anchor)) observer.observe(anchor);
      }
    }

    // Single-page apps often render their links after load; pick those up too.
    domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) watchLinksIn(node);
        }
      }
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
    watchLinksIn(document);
  }

  browser.storage.sync.get(["active", "preloadViewport", "preloadAssets", "blacklistSites"]).then(
    ({ active, preloadViewport, preloadAssets: assets, blacklistSites }) => {
      if (active === false || isBlacklisted(blacklistSites)) return;
      // Viewport and asset preloading default on; only an explicit false disables them.
      preloadAssets = assets !== false;
      listenForIntent();
      if (preloadViewport === false) return;
      const whenIdle = window.requestIdleCallback
        ? (callback) => requestIdleCallback(callback, { timeout: 1500 })
        : (callback) => setTimeout(callback, 0);
      whenIdle(preloadVisibleLinks);
    },
    (error) => console.error("[snappy pageload] Could not read settings:", error)
  );
})();
