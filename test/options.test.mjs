import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { readScript, sleep } from "./helpers.mjs";

function loadOptionsPage(stored = {}, { privacy = true } = {}) {
  const html = readFileSync(new URL("../options.html", import.meta.url), "utf8").replace(/<script[^>]*><\/script>/g, "");
  const { window } = new JSDOM(html, { runScripts: "outside-only" });
  const storage = { ...stored };
  window.browser = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...storage }),
        set: async (values) => Object.assign(storage, values),
      },
    },
  };
  if (privacy) window.browser.privacy = { network: { networkPredictionEnabled: {} } };
  window.eval(readScript("shared.js"));
  window.eval(readScript("options.js"));
  return { window, document: window.document, storage };
}

async function restoredOptionsPage(stored, options) {
  const page = loadOptionsPage(stored, options);
  page.window.document.dispatchEvent(new page.window.Event("DOMContentLoaded"));
  await sleep(0);
  return page;
}

async function submit(page) {
  page.document.querySelector("form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await sleep(0);
}

async function submitBlacklist(page, value) {
  page.document.getElementById("blacklistSites").value = value;
  await submit(page);
}

test("blacklist entries are reduced to hosts before saving", async () => {
  const page = loadOptionsPage();
  await submitBlacklist(page, " WWW.Example.test , https://shop.example.test:8443/cart, *.news.example.test, localhost:3000, www.example.test");
  assert.equal(page.storage.blacklistSites, "www.example.test,shop.example.test,*.news.example.test,localhost");
  assert.match(page.document.getElementById("status").textContent, /^Saved/);
});

test("international domain names are stored as punycode", async () => {
  const page = loadOptionsPage();
  await submitBlacklist(page, "bücher.example");
  assert.equal(page.storage.blacklistSites, "xn--bcher-kva.example");
});

test("invalid entries block saving and are reported", async () => {
  const page = loadOptionsPage({ blacklistSites: "kept.example.test" });
  await submitBlacklist(page, "good.example.test, not a host, *.");
  assert.equal(page.storage.blacklistSites, "kept.example.test");
  assert.match(page.document.getElementById("status").textContent, /Invalid blacklist entries: not a host, \*\./);
});

test("visible-link and asset preloading default on and respect stored false", async () => {
  const fresh = await restoredOptionsPage();
  assert.equal(fresh.document.getElementById("preloadViewport").checked, true);
  assert.equal(fresh.document.getElementById("preloadAssets").checked, true);

  const disabled = await restoredOptionsPage({ preloadViewport: false, preloadAssets: false });
  assert.equal(disabled.document.getElementById("preloadViewport").checked, false);
  assert.equal(disabled.document.getElementById("preloadAssets").checked, false);
});

test("the on/off switch defaults on, shows a stored off and saves", async () => {
  const fresh = await restoredOptionsPage();
  assert.equal(fresh.document.getElementById("active").checked, true);

  const page = await restoredOptionsPage({ active: false });
  assert.equal(page.document.getElementById("active").checked, false);
  page.document.getElementById("active").checked = true;
  await submit(page);
  assert.equal(page.storage.active, true);
});

test("saving options persists the asset setting", async () => {
  const page = await restoredOptionsPage();
  page.document.getElementById("preloadAssets").checked = false;
  await submit(page);
  assert.equal(page.storage.preloadAssets, false);
  assert.match(page.document.getElementById("status").textContent, /^Saved/);
});

test("built-in prefetching defaults on and saves false", async () => {
  const page = await restoredOptionsPage();
  assert.equal(page.document.getElementById("browserPrefetch").checked, true);
  page.document.getElementById("browserPrefetch").checked = false;
  await submit(page);
  assert.equal(page.storage.browserPrefetch, false);

  const stored = await restoredOptionsPage({ browserPrefetch: false });
  assert.equal(stored.document.getElementById("browserPrefetch").checked, false);
});

test("the built-in prefetching row is hidden without the privacy API", async () => {
  const shown = await restoredOptionsPage();
  assert.notEqual(shown.document.getElementById("browserPrefetch-row").style.display, "none");
  const safari = await restoredOptionsPage({}, { privacy: false });
  assert.equal(safari.document.getElementById("browserPrefetch-row").style.display, "none");
});
