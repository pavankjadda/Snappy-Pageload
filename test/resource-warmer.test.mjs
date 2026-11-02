import { test } from "node:test";
import assert from "node:assert/strict";
import { runContentScript, sleep } from "./helpers.mjs";

const PAGE = "https://site.example.test/index.html";

function response(body, url, contentType = "text/html; charset=utf-8") {
  const result = new Response(body, { headers: { "content-type": contentType } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

// Runs the warmer via the shared content-script harness. Unlike the harness default, a warmer
// behaves like Safari (no native prefetch, preload hints) unless `prefetch` is set, because most
// expectations below were written for that mode. Hint links never load in jsdom, so by default a
// load event is fired for every appended link; `autoLoad: false` leaves that to the test.
function createWarmer({
  fetch = async (url) => response("<!doctype html><html></html>", url), saveData = false,
  prefetch = false, autoLoad = true, matchMedia, devicePixelRatio, innerWidth,
} = {}) {
  const { window, document } = runContentScript("resource-warmer.js", {
    url: PAGE, fetch, saveData, prefetchSupported: prefetch, autoLoad, matchMedia, devicePixelRatio, innerWidth,
  });
  return { window, document, warmPage: window.fasterPageloadWarmPage };
}

function hints(document) {
  return [...document.querySelectorAll('link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"]')];
}

function hintPaths(document) {
  return hints(document).map((hint) => new URL(hint.href).pathname);
}

// Fires load on every appended link until the promise settles (for autoLoad: false warmers).
async function drive(warmer, promise) {
  const fired = new Set();
  let done = false;
  void promise.then(() => { done = true; });
  while (!done) {
    for (const link of warmer.document.querySelectorAll("link")) {
      if (fired.has(link)) continue;
      fired.add(link);
      link.dispatchEvent(new warmer.window.Event("load"));
    }
    await sleep(5);
  }
  return promise;
}

function pageWith(body, head = "") {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

test("destination markup stays inert while typed hints resolve against its base URL", async () => {
  const fetched = [];
  const html = `<!doctype html><html><head>
    <base href="/cdn/v2/">
    <link rel="stylesheet" href="css/main.css" integrity="sha256-style" media="screen">
    <link rel="modulepreload" href="js/module.js">
    <link rel="preload" as="script" href="js/classic.js">
    <link rel="preload" as="font" href="fonts/site.woff2">
    <script src="js/execute.js">window.destinationCodeRan = true</script>
    <script type="module" src="js/app.js"></script>
    <img src="images/hero.png" srcset="images/hero.png 1x, images/hero@2x.png 2x" sizes="50vw">
  </head><body><picture><source srcset="images/pic.webp 1x" type="image/webp"><img src="images/pic.png"></picture></body></html>`;
  const pageUrl = "https://site.example.test/catalog/item";
  const warmer = createWarmer({ fetch: async (url) => {
    fetched.push(url);
    return response(html, url);
  } });
  await warmer.warmPage(pageUrl);

  assert.equal(warmer.window.destinationCodeRan, undefined, "destination scripts must not execute");
  const byPath = new Map(hints(warmer.document).map((hint) => [new URL(hint.href).pathname, hint]));
  assert.ok(byPath.get("/cdn/v2/css/main.css"));
  assert.equal(byPath.get("/cdn/v2/css/main.css").getAttribute("as"), "style");
  assert.equal(byPath.get("/cdn/v2/css/main.css").getAttribute("integrity"), "sha256-style");
  assert.equal(byPath.get("/cdn/v2/css/main.css").media, "screen");
  assert.equal(byPath.get("/cdn/v2/js/module.js").rel, "modulepreload");
  assert.equal(byPath.get("/cdn/v2/js/classic.js").getAttribute("as"), "script");
  assert.equal(byPath.get("/cdn/v2/fonts/site.woff2").getAttribute("as"), "font");
  assert.equal(byPath.get("/cdn/v2/fonts/site.woff2").crossOrigin, "anonymous");
  assert.equal(byPath.get("/cdn/v2/js/execute.js").getAttribute("as"), "script");
  assert.equal(byPath.get("/cdn/v2/js/app.js").rel, "modulepreload");
  const hero = byPath.get("/cdn/v2/images/hero.png");
  assert.equal(hero.getAttribute("as"), "image");
  assert.equal(hero.getAttribute("imagesrcset"), "https://site.example.test/cdn/v2/images/hero.png 1x, https://site.example.test/cdn/v2/images/hero@2x.png 2x");
  assert.equal(hero.getAttribute("imagesizes"), "50vw");
  assert.ok(byPath.get("/cdn/v2/images/pic.webp"));
  assert.ok(fetched.includes("https://site.example.test/catalog/item"));
});

test("CSS imports and URLs honor comments, strings, quoting, and escapes", async () => {
  const requests = [];
  const warmer = createWarmer({ fetch: async (url) => {
    requests.push(url);
    if (url.endsWith("/styles/main.css")) {
      return response(`/* url(fake-comment.png) */ .x { content: "url(fake-string.png)"; }  @font-face { font-family: x; src: url('../fonts/a\\20 b.woff2') } @import "nested\\2e css";`, url, "text/css");
    }
    if (url.endsWith("/styles/nested.css")) return response("@font-face { font-family: n; src: url(icons/n.woff2) }", url, "text/css");
    return response("<html><head><link rel=stylesheet href='/styles/main.css'></head></html>", url);
  } });
  await warmer.warmPage("https://site.example.test/catalog/page");
  const paths = hints(warmer.document).map((hint) => new URL(hint.href).pathname);
  assert.ok(paths.includes("/styles/nested.css"));
  assert.ok(paths.includes("/fonts/a%20b.woff2"));
  assert.ok(paths.includes("/styles/icons/n.woff2"));
  assert.ok(!paths.some((path) => /fake-(comment|string)/.test(path)));
  assert.ok(requests.includes("https://site.example.test/styles/nested.css"));
});

test("styled images retain their source and request metadata variants obey hint budgets", async () => {
  const scripts = Array.from({ length: 30 }, (_, i) => `<script src="/shared.js" integrity="sha256-${i}"></script>`).join("");
  const warmer = createWarmer({ fetch: async (url) => response(
    `<img src="/hero.png" style="background:url('/background.png')">${scripts}`, url,
  ) });
  await warmer.warmPage("https://site.example.test/styled");
  const links = hints(warmer.document);
  assert.ok(links.some((link) => link.href.endsWith("/hero.png")));
  assert.ok(links.some((link) => link.href.endsWith("/background.png")));
  assert.equal(links.length, 20);
});

test("asset hints deduplicate across destination pages and CSS import cycles", async () => {
  const requests = [];
  const htmlByPath = new Map([
    ["/a", '<html><head><link rel="stylesheet" href="/css/a.css"><img src="/shared.png"></head></html>'],
    ["/b", '<html><head><link rel="stylesheet" href="/css/a.css"><img src="/shared.png"></head></html>'],
  ]);
  const warmer = createWarmer({ fetch: async (url) => {
    requests.push(url);
    if (url.endsWith(".css")) {
      const name = url.split("/").at(-1);
      return response(name === "a.css" ? '@import "b.css"; .a{background:url(/shared.png)}' : '@import "a.css"; .b{background:url(/other.png)}', url, "text/css");
    }
    return response(htmlByPath.get(new URL(url).pathname) || "<html></html>", url);
  } });
  const results = await Promise.all([
    warmer.warmPage("https://site.example.test/a"),
    warmer.warmPage("https://site.example.test/b"),
  ]);
  assert.ok(results.every((result) => result.assets >= 2));
  assert.equal(hints(warmer.document).filter((hint) => hint.href.endsWith("/css/a.css") || hint.href.endsWith("/css/b.css")).length, 2);
  assert.equal(hints(warmer.document).filter((hint) => hint.href.endsWith("/shared.png")).length, 1);
  assert.equal(requests.filter((url) => url.endsWith("/css/a.css")).length, 1);
  assert.equal(requests.filter((url) => url.endsWith("/css/b.css")).length, 1);
});

test("page and global asset budgets cap hints at 20 per page and 100 total", async () => {
  const warmer = createWarmer({ fetch: async (url) => {
    const n = new URL(url).pathname.slice(1);
    const assets = Array.from({ length: 24 }, (_, i) => `<script src="/assets/${n}-${i}.js"></script>`).join("");
    return response(`<html><body>${assets}</body></html>`, url);
  } });
  for (let page = 0; page < 6; page++) await warmer.warmPage(`https://site.example.test/page${page}`);
  assert.equal(hints(warmer.document).length, 100);
  for (let page = 0; page < 5; page++) {
    assert.equal(hints(warmer.document).filter((hint) => hint.href.includes(`/assets/page${page}-`)).length, 20);
  }
});

test("page fetch concurrency is limited to four", async () => {
  let active = 0;
  let maxActive = 0;
  const warmer = createWarmer({ fetch: async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    return response("<html></html>", url);
  } });
  await Promise.all(Array.from({ length: 10 }, (_, i) => warmer.warmPage(`https://site.example.test/page-${i}`)));
  assert.equal(maxActive, 4);
});

test("external destination pages, unsafe schemes, credentials and HTTPS downgrades are rejected", async () => {
  const requests = [];
  const html = `<html><head>
    <link rel="stylesheet" href="https://other.example.test/foreign.css">
    <script src="javascript:alert(1)"></script><img src="http://site.example.test/insecure.png">
    <img src="data:image/png;base64,AA=="><img src="//other.example.test/x.png">
    <img src="https://user:pass@site.example.test/private.png">
  </head></html>`;
  const warmer = createWarmer({ fetch: async (url) => {
    requests.push(url);
    return response(html, url);
  } });
  await warmer.warmPage("https://other.example.test/page");
  await warmer.warmPage("http://site.example.test/downgrade");
  await warmer.warmPage("https://site.example.test/allowed");
  assert.deepEqual(requests.filter((url) => url === "https://other.example.test/page" || url === "http://site.example.test/downgrade" || url === "https://site.example.test/allowed"), ["https://site.example.test/allowed"]);
  const hintedUrls = hints(warmer.document).map((hint) => hint.href);
  assert.ok(!hintedUrls.some((url) => url.startsWith("http://") || /javascript:|data:|user:pass/.test(url)));

  const saveData = createWarmer({ saveData: true, fetch: async (url) => { requests.push(url); return response("<html></html>", url); } });
  await saveData.warmPage("https://site.example.test/save-data");
  assert.deepEqual(requests.filter((url) => url === "https://site.example.test/allowed" || url === "https://site.example.test/save-data"), ["https://site.example.test/allowed"]);
});

test("oversized streamed HTML is rejected without creating asset hints", async () => {
  // The first chunk already references an asset, so dropping the size limit would hint it.
  const head = new TextEncoder().encode('<html><body><img src="/leak.png">');
  const first = new Uint8Array(1024 * 1024).fill(0x20);
  first.set(head);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
      controller.enqueue(new Uint8Array(1).fill(0x20));
      controller.close();
    },
    cancel() {},
  });
  const warmer = createWarmer({ fetch: async (url) => {
    const result = new Response(body, { headers: { "content-type": "text/html" } });
    Object.defineProperty(result, "url", { value: url });
    return result;
  } });
  await warmer.warmPage("https://site.example.test/large");
  assert.deepEqual(hints(warmer.document), []);
});

test("cross-origin bases allow valid hints and module and classic hints stay distinct", async () => {
  const requests = [];
  const html = `<html><head><base href="https://cdn.example.test/assets/">
    <script type="module" src="shared.js"></script><script src="shared.js"></script>
    <link rel="stylesheet" href="style.css"><img src="hero.png">
  </head></html>`;
  const warmer = createWarmer({ fetch: async (url) => {
    requests.push(url);
    return response(html, url);
  } });
  await warmer.warmPage("https://site.example.test/cross-base");
  const cdnHints = hints(warmer.document).filter((hint) => new URL(hint.href).origin === "https://cdn.example.test");
  assert.equal(cdnHints.filter((hint) => hint.href.endsWith("/assets/shared.js")).length, 2);
  assert.ok(cdnHints.some((hint) => hint.rel === "modulepreload"));
  assert.ok(cdnHints.some((hint) => hint.rel === "preload" && hint.getAttribute("as") === "script"));
  assert.ok(cdnHints.some((hint) => hint.href.endsWith("/assets/hero.png")));
  assert.deepEqual(requests, ["https://site.example.test/cross-base"], "cross-origin CSS should not be fetched for inspection");
});

test("Firefox gets prefetch hints and Safari gets preload and modulepreload hints", async () => {
  const html = pageWith('<script src="/js/classic.js"></script><script type="module" src="/js/app.js"></script>');
  const firefox = createWarmer({ prefetch: true, fetch: async (url) => response(html, url) });
  await firefox.warmPage("https://site.example.test/next");
  assert.deepEqual(hints(firefox.document).map((link) => link.rel), ["prefetch", "prefetch"]);
  assert.equal(firefox.document.querySelector('link[href$="/js/app.js"]').getAttribute("as"), "script");
  assert.equal(firefox.document.querySelector('link[href$="/js/classic.js"]').getAttribute("as"), "script");

  const safari = createWarmer({ fetch: async (url) => response(html, url) });
  await safari.warmPage("https://site.example.test/next");
  assert.equal(safari.document.querySelector('link[href$="/js/classic.js"]').rel, "preload");
  assert.equal(safari.document.querySelector('link[href$="/js/app.js"]').rel, "modulepreload");
});

test("hints mirror the cross-origin mode of the real request", async () => {
  const html = pageWith(`
    <script src="/js/plain.js"></script><script src="/js/cors.js" crossorigin></script>
    <script type="module" src="/js/mod.js"></script><script type="module" src="/js/modcred.js" crossorigin="use-credentials"></script>
    <link rel="stylesheet" href="/css/plain.css"><link rel="stylesheet" href="/css/cors.css" crossorigin>
    <link rel="preload" as="font" href="/fonts/f.woff2"><img src="/img/plain.png"><img src="/img/cred.png" crossorigin="use-credentials">`);
  for (const prefetch of [true, false]) {
    const warmer = createWarmer({ prefetch, fetch: async (url) => response(html, url) });
    await warmer.warmPage("https://site.example.test/cors");
    const cross = (suffix) => warmer.document.querySelector(`link[href$="${suffix}"]`).getAttribute("crossorigin");
    assert.equal(cross("/js/plain.js"), null);
    assert.equal(cross("/js/cors.js"), "anonymous");
    assert.equal(cross("/js/mod.js"), "anonymous");
    assert.equal(cross("/js/modcred.js"), "use-credentials");
    assert.equal(cross("/css/plain.css"), null);
    assert.equal(cross("/css/cors.css"), "anonymous");
    assert.equal(cross("/fonts/f.woff2"), "anonymous");
    assert.equal(cross("/img/plain.png"), null);
    assert.equal(cross("/img/cred.png"), "use-credentials");
  }
});

test("the page fetch awaits the native prefetch and then reads the HTTP cache", async () => {
  const calls = [];
  let release;
  const after = new Promise((resolve) => { release = resolve; });
  const warmer = createWarmer({ fetch: async (url, init) => { calls.push({ url, init }); return response("<html></html>", url); } });
  const run = warmer.warmPage("https://site.example.test/next", { after });
  await sleep(40);
  assert.equal(calls.length, 0, "must wait for the prefetch to settle");
  release();
  await run;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.cache, "force-cache");
  assert.equal(calls[0].init.mode, "same-origin");

  const plain = createWarmer({ fetch: async (url, init) => { calls.push({ url, init }); return response("<html></html>", url); } });
  await plain.warmPage("https://site.example.test/other");
  assert.equal(calls[1].init.cache, "default");
});

test("a rejected prefetch promise does not block the page fetch", async () => {
  const calls = [];
  const warmer = createWarmer({ fetch: async (url, init) => { calls.push(init); return response("<html></html>", url); } });
  await warmer.warmPage("https://site.example.test/next", { after: Promise.reject(new Error("failed")) });
  assert.equal(calls.length, 1);
});

test("fetches carry speculative-request headers", async () => {
  const calls = [];
  const warmer = createWarmer({ fetch: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith(".css")) return response("@import 'b.css';", url, "text/css");
    return response('<link rel="stylesheet" href="/a.css">', url);
  } });
  await warmer.warmPage("https://site.example.test/next");
  assert.ok(calls.length >= 2);
  for (const { init } of calls) {
    assert.equal(init.headers["X-Moz"], "prefetch");
    assert.equal(init.headers.Purpose, "prefetch");
  }
});

test("unsafe, tracker and captcha asset URLs are never hinted", async () => {
  const html = pageWith(`
    <img src="/counter.php?action=view"><img src="/account/logout.gif"><img src="/captcha/image.php">
    <img src="/images/pixel.gif"><img src="/ads/banner.png"><img src="/img/tracking-1x1.gif">
    <img src="https://ads.example.test/ad.gif?id=1"><img src="/img/%6Cogout.png">
    <script src="/js/analytics.js"></script><script src="/js/beacon.js"></script><script src="/js/app.js"></script>
    <img src="/uploads/photo.png"><img src="/img/shadow.png"><img src="/img/adobe-logo.png">`);
  const warmer = createWarmer({ fetch: async (url) => response(html, url) });
  await warmer.warmPage("https://site.example.test/next");
  assert.deepEqual(hintPaths(warmer.document).sort(), ["/img/adobe-logo.png", "/img/shadow.png", "/js/app.js", "/uploads/photo.png"]);
});

test("noscript, lazy, tiny and nomodule resources are skipped", async () => {
  const html = pageWith(`
    <noscript><img src="/img/noscript.png"><link rel="stylesheet" href="/css/noscript.css"></noscript>
    <img src="/img/lazy.png" loading="lazy"><img src="/img/tiny.gif" width="1" height="1"><img src="/img/thin.gif" height="2">
    <img src="/img/eager.png" loading="eager" width="300">
    <script nomodule src="/js/legacy.js"></script><script src="/js/modern.js"></script>
    <picture><source srcset="/img/lazy-pic.webp" type="image/webp"><img src="/img/lazy-fallback.png" loading="lazy"></picture>`);
  const warmer = createWarmer({ fetch: async (url) => response(html, url) });
  await warmer.warmPage("https://site.example.test/next");
  assert.deepEqual(hintPaths(warmer.document).sort(), ["/img/eager.png", "/js/modern.js"]);
});

test("a picture contributes only its first usable source and skips the fallback image", async () => {
  const html = pageWith(`
    <picture><source type="image/heif" srcset="/img/a.heif"><source media="(min-width: 5000px)" srcset="/img/wide.png">
      <source type="image/webp" srcset="/img/ok.webp"><source srcset="/img/second.png"><img src="/img/fallback.png"></picture>
    <picture><source type="image/heif" srcset="/img/b.heif"><img src="/img/only-img.png"></picture>`);
  const warmer = createWarmer({
    fetch: async (url) => response(html, url),
    matchMedia: (query) => ({ matches: !query.includes("5000") }),
  });
  await warmer.warmPage("https://site.example.test/next");
  assert.deepEqual(hintPaths(warmer.document).sort(), ["/img/ok.webp", "/img/only-img.png"]);
});

test("at most six images are hinted per destination page without consuming other budget", async () => {
  const images = Array.from({ length: 9 }, (_, i) => `<img src="/img/${i}.png">`).join("");
  const warmer = createWarmer({ fetch: async (url) => response(pageWith(`${images}<script src="/js/a.js"></script>`), url) });
  const result = await warmer.warmPage("https://site.example.test/next");
  assert.equal(hints(warmer.document).filter((hint) => hint.getAttribute("as") === "image").length, 6);
  assert.equal(hintPaths(warmer.document).filter((path) => path.endsWith(".js")).length, 1);
  assert.equal(result.assets, 7, "refused images must not count");
});

test("summary reports the page just warmed, not running totals", async () => {
  const warmer = createWarmer({ fetch: async (url) => {
    const n = url.endsWith("/a") ? 2 : 3;
    return response(pageWith(Array.from({ length: n }, (_, i) => `<script src="${new URL(url).pathname}-${i}.js"></script>`).join("")), url);
  } });
  assert.deepEqual({ ...await warmer.warmPage("https://site.example.test/a") }, { pages: 1, assets: 2 });
  assert.deepEqual({ ...await warmer.warmPage("https://site.example.test/b") }, { pages: 1, assets: 3 });
});

test("Firefox picks one srcset candidate; Safari keeps the whole srcset", async () => {
  const widths = pageWith('<img src="/img/s.png" srcset="/img/s.png 400w, /img/m.png 800w, /img/l.png 1600w" sizes="(max-width: 600px) 100vw, 50vw">');
  const densities = pageWith('<img src="/img/d1.png" srcset="/img/d1.png 1x, /img/d2.png 2x, /img/d3.png 3x">');
  const plain = pageWith('<img src="/img/plain.png">');
  const pick = async (html, options) => {
    const warmer = createWarmer({ prefetch: true, fetch: async (url) => response(html, url), ...options });
    await warmer.warmPage("https://site.example.test/next");
    const links = hints(warmer.document);
    assert.equal(links.length, 1);
    assert.equal(links[0].rel, "prefetch");
    assert.equal(links[0].getAttribute("imagesrcset"), null);
    return new URL(links[0].href).pathname;
  };
  const narrowOff = (query) => ({ matches: false, media: query });
  const narrowOn = (query) => ({ matches: true, media: query });
  // sizes falls through to 50vw of 1000px = 500 CSS px
  assert.equal(await pick(widths, { innerWidth: 1000, devicePixelRatio: 1, matchMedia: narrowOff }), "/img/m.png");
  assert.equal(await pick(widths, { innerWidth: 1000, devicePixelRatio: 2, matchMedia: narrowOff }), "/img/l.png");
  // the media condition matches: 100vw of 1000px = 1000 CSS px, so even 1x needs the largest
  assert.equal(await pick(widths, { innerWidth: 1000, devicePixelRatio: 1, matchMedia: narrowOn }), "/img/l.png");
  assert.equal(await pick(widths, { innerWidth: 300, devicePixelRatio: 1, matchMedia: narrowOn }), "/img/s.png");
  assert.equal(await pick(densities, { devicePixelRatio: 2 }), "/img/d2.png");
  assert.equal(await pick(densities, { devicePixelRatio: 1.5 }), "/img/d2.png");
  assert.equal(await pick(densities, { devicePixelRatio: 4 }), "/img/d3.png");
  assert.equal(await pick(plain, {}), "/img/plain.png");

  const safari = createWarmer({ fetch: async (url) => response(densities, url) });
  await safari.warmPage("https://site.example.test/next");
  assert.equal(hints(safari.document)[0].getAttribute("imagesrcset"),
    "https://site.example.test/img/d1.png 1x, https://site.example.test/img/d2.png 2x, https://site.example.test/img/d3.png 3x");
});

test("an image preload with only imagesrcset still produces a hint", async () => {
  const html = pageWith('<link rel="preload" as="image" imagesrcset="/img/x1.png 1x, /img/x2.png 2x" imagesizes="100vw">');
  const safari = createWarmer({ fetch: async (url) => response(html, url) });
  await safari.warmPage("https://site.example.test/next");
  const [safariHint] = hints(safari.document);
  assert.equal(safariHint.rel, "preload");
  assert.equal(safariHint.getAttribute("imagesrcset"), "https://site.example.test/img/x1.png 1x, https://site.example.test/img/x2.png 2x");
  const firefox = createWarmer({ prefetch: true, devicePixelRatio: 2, fetch: async (url) => response(html, url) });
  await firefox.warmPage("https://site.example.test/next");
  assert.deepEqual(hintPaths(firefox.document), ["/img/x2.png"]);
});

test("font-face keeps the first url of the last src and honours unicode-range", async () => {
  const css = `
    @font-face { font-family: A; src: url(/fonts/old.woff) format("woff"); src: local(Arial), url("/fonts/new.woff2") format("woff2"), url(/fonts/fallback.woff) format("woff"); }
    @font-face { font-family: B; src: url(/fonts/latin.woff2); unicode-range: U+0000-00FF, U+0131; }
    @font-face { font-family: B; src: url(/fonts/greek.woff2); unicode-range: U+0370-03FF; }
    @font-face { font-family: B; src: url(/fonts/cjk.woff2); unicode-range: U+4E??; }
    @font-face { font-family: B; src: url(/fonts/emoji.woff2); unicode-range: U+1F600-1F64F; }
    @font-face { font-family: C; src: url(data:font/woff2;base64,AAAA); }`;
  const html = pageWith("<p>Hello \u{1F600}</p>".replace("\\u{1F600}", "\u{1F600}"), `<title>Caf\u00e9</title><style>${css}</style>`);
  const warmer = createWarmer({ fetch: async (url) => response(html, url) });
  await warmer.warmPage("https://site.example.test/next");
  assert.deepEqual(hintPaths(warmer.document).sort(), ["/fonts/emoji.woff2", "/fonts/latin.woff2", "/fonts/new.woff2"]);
});

test("stylesheet and style-element background urls are ignored but style attributes are images", async () => {
  const css = ".x { background: url(/img/bg.png) } @media (prefers-color-scheme: dark) { .x { background: image-set(url(/img/dark.png) 1x) } }";
  const html = pageWith('<div style="background:url(/img/inline.png)"></div>', `<style>${css}</style><link rel="stylesheet" href="/css/site.css">`);
  const requests = [];
  const warmer = createWarmer({ fetch: async (url) => {
    requests.push(url);
    return url.endsWith(".css") ? response(css, url, "text/css") : response(html, url);
  } });
  await warmer.warmPage("https://site.example.test/next");
  assert.deepEqual(hintPaths(warmer.document).sort(), ["/css/site.css", "/img/inline.png"]);
  assert.ok(requests.includes("https://site.example.test/css/site.css"));
});

test("assets found in CSS do not inherit attributes from the element holding the CSS", async () => {
  const html = pageWith(
    '<img src="/img/real.png" crossorigin="use-credentials" integrity="sha256-x" referrerpolicy="no-referrer" style="background:url(/img/bg.png)">',
    '<style type="text/css" media="print" crossorigin="use-credentials" integrity="sha256-y" referrerpolicy="origin">@font-face { font-family: f; src: url(/fonts/f.woff2) }</style>');
  for (const prefetch of [true, false]) {
    const warmer = createWarmer({ prefetch, fetch: async (url) => response(html, url) });
    await warmer.warmPage("https://site.example.test/next");
    const hint = (suffix) => warmer.document.querySelector(`link[href$="${suffix}"]`);
    const font = hint("/fonts/f.woff2");
    assert.equal(font.getAttribute("type"), "font/woff2");
    assert.equal(font.getAttribute("crossorigin"), "anonymous");
    for (const name of ["integrity", "media", "referrerpolicy"]) assert.equal(font.getAttribute(name), null, name);
    const background = hint("/img/bg.png");
    for (const name of ["integrity", "media", "referrerpolicy", "crossorigin", "type"]) assert.equal(background.getAttribute(name), null, name);
    const real = hint("/img/real.png");
    assert.equal(real.getAttribute("crossorigin"), "use-credentials");
    assert.equal(real.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(real.getAttribute("integrity"), null);
  }
});

test("Safari keeps at most four preload hints outstanding until their load or error events", async () => {
  const scripts = Array.from({ length: 10 }, (_, i) => `<script src="/js/${i}.js"></script>`).join("");
  const warmer = createWarmer({ prefetch: false, autoLoad: false, fetch: async (url) => response(pageWith(scripts), url) });
  const run = warmer.warmPage("https://site.example.test/next");
  const fired = new Set();
  let maxOutstanding = 0;
  for (let round = 0; round < 60; round++) {
    await sleep(5);
    const links = [...warmer.document.querySelectorAll("link")];
    const outstanding = links.filter((link) => !fired.has(link));
    maxOutstanding = Math.max(maxOutstanding, outstanding.length);
    if (!outstanding.length && links.length === 10) break;
    // Alternate load and error: both must release a slot.
    outstanding.forEach((link, index) => {
      fired.add(link);
      link.dispatchEvent(new warmer.window.Event(index % 2 ? "error" : "load"));
    });
  }
  await run;
  assert.equal(maxOutstanding, 4);
  assert.equal(warmer.document.querySelectorAll("link").length, 10);
});

test("Firefox appends every prefetch hint at once, leaving queueing to the browser", async () => {
  const scripts = Array.from({ length: 10 }, (_, i) => `<script src="/js/${i}.js"></script>`).join("");
  const warmer = createWarmer({ prefetch: true, autoLoad: false, fetch: async (url) => response(pageWith(scripts), url) });
  const run = warmer.warmPage("https://site.example.test/next");
  await sleep(40);
  const links = [...warmer.document.querySelectorAll("link")];
  assert.equal(links.length, 10, "no hint waits for another to settle");
  assert.ok(links.every((link) => link.rel === "prefetch"));
  assert.ok(links.every((link) => !link.hasAttribute("fetchpriority") && link.fetchPriority !== "low"));
  await drive(warmer, run);
});

test("a stylesheet is fetched for parsing once, from cache, after its hint settled", async () => {
  const requests = [];
  const warmer = createWarmer({ autoLoad: false, fetch: async (url, init) => {
    requests.push({ url, cache: init.cache });
    return url.endsWith(".css") ? response("@font-face { font-family: f; src: url(/fonts/f.woff2) }", url, "text/css")
      : response(pageWith('<link rel="stylesheet" href="/css/a.css">'), url);
  } });
  const run = warmer.warmPage("https://site.example.test/next");
  await sleep(40);
  const link = warmer.document.querySelector('link[href$="/css/a.css"]');
  assert.ok(link, "stylesheet hint is added");
  assert.ok(!requests.some((request) => request.url.endsWith(".css")), "no parse fetch before the hint settled");
  link.dispatchEvent(new warmer.window.Event("load"));
  await drive(warmer, run);
  const cssRequests = requests.filter((request) => request.url.endsWith(".css"));
  assert.equal(cssRequests.length, 1);
  assert.equal(cssRequests[0].cache, "force-cache");
  assert.ok(hintPaths(warmer.document).includes("/fonts/f.woff2"));
});

test("a cross-origin redirect of the page is rejected", async () => {
  const warmer = createWarmer({ fetch: async () => response(pageWith('<img src="/img/redirected.png">'), "https://other.example.test/landing") });
  await warmer.warmPage("https://site.example.test/next");
  assert.deepEqual(hints(warmer.document), []);
});

test("non-HTML responses are ignored", async () => {
  const warmer = createWarmer({ fetch: async (url) => response(pageWith('<img src="/img/x.png">'), url, "text/plain") });
  await warmer.warmPage("https://site.example.test/next");
  assert.deepEqual(hints(warmer.document), []);
});
