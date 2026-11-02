import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const SCRIPT = readFileSync(new URL("../js/resource-warmer.js", import.meta.url), "utf8");
const PAGE = "https://site.example.test/index.html";

function response(body, url, contentType = "text/html; charset=utf-8", headers = {}) {
  const result = new Response(body, { headers: { "content-type": contentType, ...headers } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function createWarmer({ fetch = async (url) => response("<!doctype html><html></html>", url), saveData = false } = {}) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: PAGE, runScripts: "outside-only", pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = fetch;
  window.TextDecoder = TextDecoder;
  Object.defineProperty(window.navigator, "connection", { configurable: true, value: { saveData } });
  window.eval(SCRIPT);
  return { window, document: window.document, warmPage: window.fasterPageloadWarmPage };
}

function hints(document) {
  return [...document.querySelectorAll('link[rel="preload"], link[rel="modulepreload"]')];
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
  assert.equal(byPath.get("/cdn/v2/css/main.css").as, "style");
  assert.equal(byPath.get("/cdn/v2/css/main.css").getAttribute("integrity"), "sha256-style");
  assert.equal(byPath.get("/cdn/v2/css/main.css").media, "screen");
  assert.equal(byPath.get("/cdn/v2/js/module.js").rel, "modulepreload");
  assert.equal(byPath.get("/cdn/v2/js/classic.js").as, "script");
  assert.equal(byPath.get("/cdn/v2/fonts/site.woff2").as, "font");
  assert.equal(byPath.get("/cdn/v2/fonts/site.woff2").crossOrigin, "anonymous");
  assert.equal(byPath.get("/cdn/v2/js/execute.js").as, "script");
  assert.equal(byPath.get("/cdn/v2/js/app.js").rel, "modulepreload");
  const hero = byPath.get("/cdn/v2/images/hero.png");
  assert.equal(hero.as, "image");
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
      return response(`/* url(fake-comment.png) */ .x { content: "url(fake-string.png)"; background: url('../img/a\\20 b.png') } @import "nested\\2e css";`, url, "text/css");
    }
    if (url.endsWith("/styles/nested.css")) return response(".n { background: url(icons/n.png) }", url, "text/css");
    return response("<html><head><link rel=stylesheet href='/styles/main.css'></head></html>", url);
  } });
  await warmer.warmPage("https://site.example.test/catalog/page");
  const paths = hints(warmer.document).map((hint) => new URL(hint.href).pathname);
  assert.ok(paths.includes("/styles/nested.css"));
  assert.ok(paths.includes("/img/a%20b.png"));
  assert.ok(paths.includes("/styles/icons/n.png"));
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
    const assets = Array.from({ length: 24 }, (_, i) => `<img src="/assets/${n}-${i}.png">`).join("");
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
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1024 * 1024));
      controller.enqueue(new Uint8Array(1));
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
  assert.ok(cdnHints.some((hint) => hint.rel === "preload" && hint.as === "script"));
  assert.ok(cdnHints.some((hint) => hint.href.endsWith("/assets/hero.png")));
  assert.deepEqual(requests, ["https://site.example.test/cross-base"], "cross-origin CSS should not be fetched for inspection");
});
