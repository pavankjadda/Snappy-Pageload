import { test } from "node:test";
import assert from "node:assert/strict";
import { runContentScript, prefetchedUrls, sleep } from "./helpers.mjs";

const PAGE = `<!doctype html><html><head></head><body>
  <a id="plain" href="/cart">cart</a>
  <a id="query" href="/search?q=shoes&page=2">search</a>
  <a id="external" href="https://other.example.test/page">external</a>
  <a id="credentials" href="https://person:secret@shop.example.test/private">credentials</a>
  <a id="logout" href="/account/logout">logout</a>
  <a id="sign-out" href="/users/sign_out">sign out</a>
  <a id="encoded" href="/session?do=log%5Fout">encoded logout</a>
  <a id="delete" href="/items?action=delete&id=7">delete</a>
  <a id="hash" href="#reviews">reviews</a>
  <a id="self" href="/products#">this page</a>
  <a id="download" href="/manual.pdf" download>manual</a>
  <a id="opt-out" href="/no" data-no-instant>opt out</a>
  <a id="mailto" href="mailto:help@example.test">mail</a>
  <a id="nested" href="/nested"><span id="inner">nested</span></a>
  <a id="vote" href="/posts/9/vote?dir=up">upvote</a>
  <a id="like" href="/posts/9/like">like</a>
  <a id="mark-read" href="/notifications/mark-as-read">mark read</a>
  <a id="add-to-cart" href="/cart/add_to_cart/42">buy</a>
  <a id="ugc" href="/user/someone" rel="ugc">user link</a>
  <section id="comments"><a id="in-comment" href="/spam-page">comment link</a></section>
</body></html>`;

const start = async (options = {}) => {
  const page = runContentScript("preload.js", { html: PAGE, ...options });
  await sleep(50);
  return page;
};

function intersect(observer, anchors) {
  observer.callback(anchors.map((target) => ({ target, isIntersecting: true })));
}

function hover(window, element) {
  element.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
}

// Page with only hover/touch/mousedown active, so visible-link mode does not interfere.
const startIntent = (options = {}) => start({ storage: { preloadViewport: false }, ...options });
const CART = "https://shop.example.test/cart";

test("hovering a same-origin link prefetches it after the hover delay", async () => {
  const { window, document } = await startIntent();
  hover(window, document.getElementById("plain"));
  assert.deepEqual(prefetchedUrls(document), [], "must not prefetch before the delay");
  await sleep(100);
  assert.deepEqual(prefetchedUrls(document), [CART]);
});

test("hover works with the default settings and does not warm assets", async () => {
  const { window, document, warmCalls } = await start({ warmPage: true });
  hover(window, document.getElementById("plain"));
  await sleep(100);
  assert.deepEqual(prefetchedUrls(document), [CART]);
  assert.equal(warmCalls.length, 0);
});

test("links with query strings and user-generated links are prefetched on hover", async () => {
  const { window, document } = await startIntent();
  for (const id of ["query", "ugc", "in-comment"]) {
    hover(window, document.getElementById(id));
    await sleep(100);
  }
  assert.equal(prefetchedUrls(document).length, 3);
});

test("hovering a child element of a link prefetches the link", async () => {
  const { window, document } = await startIntent();
  hover(window, document.getElementById("inner"));
  await sleep(100);
  assert.deepEqual(prefetchedUrls(document), ["https://shop.example.test/nested"]);
});

test("unsafe, external and non-navigational links are never prefetched on hover", async () => {
  const { window, document } = await startIntent();
  const skipped = ["external", "credentials", "logout", "sign-out", "encoded", "delete", "hash", "self", "download", "opt-out", "mailto", "vote", "like", "mark-read", "add-to-cart"];
  for (const id of skipped) {
    hover(window, document.getElementById(id));
    await sleep(80);
  }
  assert.deepEqual(prefetchedUrls(document), []);
});

test("leaving the link before the delay cancels the prefetch", async () => {
  const { window, document } = await startIntent();
  const link = document.getElementById("plain");
  hover(window, link);
  link.dispatchEvent(new window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  await sleep(100);
  assert.deepEqual(prefetchedUrls(document), []);
});

test("mousedown prefetches immediately and each URL is prefetched once", async () => {
  const { window, document } = await startIntent();
  const link = document.getElementById("plain");
  link.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.deepEqual(prefetchedUrls(document), [CART], "mousedown must not wait");
  hover(window, link);
  await sleep(100);
  link.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.deepEqual(prefetchedUrls(document), [CART]);
});

test("only the left mouse button prefetches on mousedown", async () => {
  const { window, document } = await startIntent();
  document.getElementById("plain").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 2 }));
  assert.deepEqual(prefetchedUrls(document), []);
});

test("touchstart prefetches immediately and suppresses the synthetic mouseover", async () => {
  const { window, document } = await startIntent();
  document.getElementById("plain").dispatchEvent(new window.Event("touchstart", { bubbles: true }));
  assert.deepEqual(prefetchedUrls(document), [CART]);
  hover(window, document.getElementById("query"));
  await sleep(100);
  assert.deepEqual(prefetchedUrls(document), [CART]);
});

test("a link retargeted during the hover delay is not prefetched", async () => {
  const { window, document } = await startIntent();
  const link = document.getElementById("plain");
  hover(window, link);
  link.href = "/account/logout";
  await sleep(100);
  assert.deepEqual(prefetchedUrls(document), []);
});

test("a link removed during the hover delay is not prefetched", async () => {
  const { window, document } = await startIntent();
  const link = document.getElementById("plain");
  hover(window, link);
  link.remove();
  await sleep(100);
  assert.deepEqual(prefetchedUrls(document), []);
});

test("a second injection into the same page is ignored", async () => {
  const { window, document, inject } = await startIntent();
  inject();
  await sleep(50);
  document.getElementById("plain").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.equal(document.querySelectorAll('link[rel="prefetch"]').length, 1);
});

test("stored preloadViewport false keeps hover but never observes links", async () => {
  const { window, document, observed } = await startIntent();
  hover(window, document.getElementById("plain"));
  await sleep(100);
  assert.equal(observed.length, 0);
  assert.deepEqual(prefetchedUrls(document), [CART]);
});

test("hover, touch and mousedown on a visible-link page do nothing until settings are read", async () => {
  const page = runContentScript("preload.js", { html: PAGE });
  hover(page.window, page.document.getElementById("plain"));
  page.document.getElementById("plain").dispatchEvent(new page.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.deepEqual(prefetchedUrls(page.document), []);
  await sleep(50);
});

test("active false and blacklisted hosts do nothing at all", async () => {
  const cases = [
    { active: false },
    { blacklistSites: "shop.example.test" },
    { blacklistSites: "other.test, SHOP.Example.Test" },
    { blacklistSites: "*.example.test" },
    { blacklistSites: "*.shop.example.test" },
  ];
  for (const storage of cases) {
    const { window, document, observed } = await start({ storage });
    const link = document.getElementById("plain");
    link.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    hover(window, link);
    await sleep(100);
    assert.equal(observed.length, 0, JSON.stringify(storage));
    assert.deepEqual(prefetchedUrls(document), [], JSON.stringify(storage));
  }
});

test("blacklist entries that do not match this host, or are invalid, are ignored", async () => {
  for (const blacklistSites of ["example.test", "*.other.test", "shop.example.test.evil.test", "not a host!, ,", ""]) {
    const { window, document } = await start({ storage: { blacklistSites } });
    document.getElementById("plain").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
    assert.deepEqual(prefetchedUrls(document), [CART], blacklistSites);
  }
});

test("a wildcard blacklist entry also matches the bare domain", async () => {
  const { window, document } = await start({
    url: "https://example.test/products",
    storage: { blacklistSites: "*.example.test" },
  });
  document.getElementById("plain").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  assert.deepEqual(prefetchedUrls(document), []);
});

test("visible link in Firefox adds a prefetch link and warms assets once the prefetch settles", async () => {
  for (const settle of ["load", "error"]) {
    const { window, document, observers, warmCalls } = await start({ warmPage: true });
    intersect(observers[0], [document.getElementById("plain")]);
    assert.deepEqual(prefetchedUrls(document), [CART]);
    await sleep(0);
    assert.equal(warmCalls.length, 1);
    const [url, options] = warmCalls[0];
    assert.equal(url, CART);
    assert.deepEqual(Object.keys(options), ["after"]);
    assert.ok(options.after instanceof window.Promise || typeof options.after.then === "function");
    let settled = false;
    options.after.then(() => { settled = true; });
    await sleep(10);
    assert.equal(settled, false, "after must wait for the prefetch");
    document.querySelector('link[rel="prefetch"]').dispatchEvent(new window.Event(settle));
    await sleep(10);
    assert.equal(settled, true, `after must resolve on ${settle}`);
  }
});

test("visible link with assets disabled only adds the prefetch link", async () => {
  const { document, observers, warmCalls } = await start({ storage: { preloadAssets: false }, warmPage: true });
  intersect(observers[0], [document.getElementById("plain")]);
  await sleep(0);
  assert.deepEqual(prefetchedUrls(document), [CART]);
  assert.equal(warmCalls.length, 0);
});

test("visible link without a warmer only adds the prefetch link", async () => {
  const { document, observers } = await start();
  intersect(observers[0], [document.getElementById("plain")]);
  assert.deepEqual(prefetchedUrls(document), [CART]);
});

test("a failing warmer does not break visible-link preloading", async () => {
  const { document, observers, observed } = await start({
    html: '<body><a href="/a">a</a><a href="/b">b</a></body>',
    warmPage: async () => { throw new Error("boom"); },
  });
  intersect(observers[0], observed);
  await sleep(10);
  assert.equal(prefetchedUrls(document).length, 2);
});

test("Safari: hover adds nothing and visible links only warm assets, without an after promise", async () => {
  const on = await start({ prefetchSupported: false, warmPage: true });
  hover(on.window, on.document.getElementById("plain"));
  on.document.getElementById("plain").dispatchEvent(new on.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
  on.document.getElementById("nested").dispatchEvent(new on.window.Event("touchstart", { bubbles: true }));
  await sleep(100);
  assert.deepEqual(prefetchedUrls(on.document), []);
  assert.equal(on.warmCalls.length, 0);
  intersect(on.observers[0], [on.document.getElementById("plain")]);
  await sleep(0);
  assert.deepEqual(prefetchedUrls(on.document), []);
  assert.deepEqual(on.warmCalls, [[CART]]);

  const off = await start({ prefetchSupported: false, warmPage: true, storage: { preloadAssets: false } });
  intersect(off.observers[0], [off.document.getElementById("plain")]);
  await sleep(0);
  assert.deepEqual(prefetchedUrls(off.document), []);
  assert.equal(off.warmCalls.length, 0);
});

test("without prefetch support and without a warmer the script stays idle", async () => {
  const { observed, observers } = await start({ prefetchSupported: false });
  assert.equal(observed.length, 0);
  assert.equal(observers.length, 0);
});

test("visible links preload once, including when the observer reports the same link again", async () => {
  const { document, observed, observers } = await start();
  const link = document.getElementById("plain");
  assert.ok(observed.includes(link));
  intersect(observers[0], [link, link]);
  intersect(observers[0], [link]);
  assert.deepEqual(prefetchedUrls(document), ["https://shop.example.test/cart"]);
});

test("same page links with different fragments warm only once", async () => {
  const { document, observers, observed } = await start({
    html: '<body><a href="/cart#first">first</a><a href="/cart#second">second</a></body>',
  });
  intersect(observers[0], observed);
  assert.deepEqual(prefetchedUrls(document), ["https://shop.example.test/cart"]);
});

test("viewport observation filters unsafe, external, queried and user-generated links", async () => {
  const { observed } = await start();
  const observedIds = observed.map(({ id }) => id);
  for (const id of ["external", "credentials", "logout", "sign-out", "encoded", "delete", "hash", "self", "download", "opt-out", "mailto", "query", "vote", "like", "mark-read", "add-to-cart", "ugc", "in-comment"]) {
    assert.ok(!observedIds.includes(id), `${id} must not be observed for automatic preload`);
  }
  assert.deepEqual(observedIds, ["plain", "nested"]);
});

test("visible links are rechecked after they change and removed links are ignored", async () => {
  const { document, observed, observers } = await start();
  const retargeted = document.getElementById("plain");
  retargeted.href = "/account/logout";
  intersect(observers[0], [retargeted]);
  assert.deepEqual(prefetchedUrls(document), []);
});

test("visible-link preloading stops at the cap", async () => {
  const links = Array.from({ length: 40 }, (_, i) => `<a href="/p/${i}">${i}</a>`).join("");
  const { document, observers, observed } = await start({ html: `<body>${links}</body>` });
  intersect(observers[0], observed);
  const urls = prefetchedUrls(document);
  assert.equal(urls.length, 30);
  assert.ok(observers[0].disconnected);
});

test("save-data skips visible-link observation", async () => {
  const saveData = await start({ saveData: true });
  assert.equal(saveData.observed.length, 0);
});

test("visible-link preloading defaults on and picks up links added after load", async () => {
  const { document, observed } = await start({ html: "<body></body>" });
  const list = document.createElement("ul");
  list.innerHTML = '<li><a id="late" href="/late">late</a></li><li><a id="late-q" href="/late?x=1">q</a></li>';
  document.body.append(list);
  const direct = document.createElement("a");
  direct.id = "late-direct";
  direct.href = "/late-direct";
  document.body.append(direct);
  await sleep(0);
  assert.deepEqual(observed.map((anchor) => anchor.id), ["late", "late-direct"]);
});
