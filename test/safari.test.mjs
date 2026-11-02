import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createFakeBrowser, readScript, settle } from "./helpers.mjs";

const adapterSource = readFileSync(new URL("../safari/content-scripts-adapter.js", import.meta.url), "utf8");

// Fake browser.scripting backed by a store that outlives any one vm ("persistAcrossSessions").
function createScripting(store = new Map()) {
  const calls = [];
  const fail = { snapshot: 0, register: 0 };
  return {
    store,
    calls,
    fail,
    api: {
      getRegisteredContentScripts: async () => {
        calls.push(["get"]);
        if (fail.snapshot > 0) {
          fail.snapshot--;
          throw new Error("snapshot failed");
        }
        return [...store.values()].map((script) => structuredClone(script));
      },
      registerContentScripts: async (scripts) => {
        calls.push(["register", scripts.map(({ id }) => id)]);
        if (fail.register > 0) {
          fail.register--;
          throw new Error("register failed");
        }
        for (const script of scripts) {
          if (store.has(script.id)) throw new Error(`duplicate id ${script.id}`);
          store.set(script.id, structuredClone(script));
        }
      },
      unregisterContentScripts: async ({ ids }) => {
        calls.push(["unregister", ids]);
        for (const id of ids) {
          if (!store.has(id)) throw new Error(`unknown id ${id}`);
          store.delete(id);
        }
      },
    },
  };
}

function loadAdapter(scripting, extra = {}) {
  const context = vm.createContext({ browser: { scripting: scripting.api, ...extra }, crypto: { randomUUID } });
  vm.runInContext(adapterSource, context);
  return { context, adapter: context.fasterPageloadContentScripts };
}

test("adapter maps {file} entries to strings in order and passes details through", async () => {
  const scripting = createScripting();
  const { adapter } = loadAdapter(scripting);
  await adapter.register({
    matches: ["http://*/*", "https://*/*"],
    excludeMatches: ["*://blocked.example.test/*"],
    js: [{ file: "js/resource-warmer.js" }, { file: "js/preload.js" }],
    runAt: "document_idle",
  });
  const [script] = scripting.store.values();
  assert.deepEqual(script.js, ["js/resource-warmer.js", "js/preload.js"]);
  assert.deepEqual(script.matches, ["http://*/*", "https://*/*"]);
  assert.deepEqual(script.excludeMatches, ["*://blocked.example.test/*"]);
  assert.equal(script.runAt, "document_idle");
  assert.equal(script.persistAcrossSessions, true);
});

test("adapter gives each registration a unique id and unregister removes only its own", async () => {
  const scripting = createScripting();
  const { adapter } = loadAdapter(scripting);
  const details = { matches: ["https://*/*"], js: [{ file: "js/a.js" }], runAt: "document_idle" };
  const first = await adapter.register(details);
  await adapter.register(details);
  assert.equal(new Set(scripting.store.keys()).size, 2);
  await first.unregister();
  assert.equal(scripting.store.size, 1);
});

test("adapter registers replacements before removing stale scripts", async () => {
  const scripting = createScripting(new Map([["fpl-safari-old-1", { id: "fpl-safari-old-1" }], ["other-ext", { id: "other-ext" }]]));
  const { adapter } = loadAdapter(scripting);
  await adapter.register({ matches: ["https://*/*"], js: [{ file: "js/a.js" }] });
  await adapter.finishUpdate();
  const kinds = scripting.calls.map(([kind]) => kind);
  assert.ok(kinds.indexOf("register") < kinds.indexOf("unregister"));
  assert.deepEqual(scripting.calls.find(([kind]) => kind === "unregister")[1], ["fpl-safari-old-1"]);
  assert.ok(scripting.store.has("other-ext"), "scripts without our prefix are left alone");
  assert.equal(scripting.store.size, 2);
});

test("adapter keeps stale scripts when a replacement fails", async () => {
  const scripting = createScripting(new Map([["fpl-safari-old-1", { id: "fpl-safari-old-1" }]]));
  const { adapter } = loadAdapter(scripting);
  scripting.fail.register = 1;
  await assert.rejects(adapter.register({ matches: ["https://*/*"], js: [{ file: "js/a.js" }] }), /register failed/);
  assert.deepEqual([...scripting.store.keys()], ["fpl-safari-old-1"]);
  // The next attempt still cleans up the stale script.
  await adapter.register({ matches: ["https://*/*"], js: [{ file: "js/a.js" }] });
  await adapter.finishUpdate();
  assert.ok(!scripting.store.has("fpl-safari-old-1"));
  assert.equal(scripting.store.size, 1);
});

test("adapter retries after a failed snapshot without losing stale cleanup", async () => {
  const scripting = createScripting(new Map([["fpl-safari-old-1", { id: "fpl-safari-old-1" }]]));
  const { adapter } = loadAdapter(scripting);
  scripting.fail.snapshot = 1;
  await assert.rejects(adapter.register({ matches: ["https://*/*"], js: [{ file: "js/a.js" }] }), /snapshot failed/);
  await adapter.register({ matches: ["https://*/*"], js: [{ file: "js/a.js" }] });
  await adapter.finishUpdate();
  assert.ok(!scripting.store.has("fpl-safari-old-1"));
  assert.equal(scripting.store.size, 1);
});

test("adapter finishUpdate retries a failed snapshot", async () => {
  const scripting = createScripting(new Map([["fpl-safari-old-1", { id: "fpl-safari-old-1" }]]));
  const { adapter } = loadAdapter(scripting);
  scripting.fail.snapshot = 1;
  await assert.rejects(adapter.finishUpdate(), /snapshot failed/);
  await adapter.finishUpdate();
  assert.equal(scripting.store.size, 0);
});

test("adapter does nothing when browser.contentScripts.register exists", () => {
  const scripting = createScripting();
  const { context } = loadAdapter(scripting, { contentScripts: { register: () => {} } });
  assert.equal(context.fasterPageloadContentScripts, undefined);
});

// Runs shared.js, the adapter, then background.js in one vm, as Safari's background scripts do.
async function startSafariBackground(scripting, stored) {
  const { browser, icons } = createFakeBrowser(stored);
  delete browser.privacy; // Safari has no browser.privacy
  browser.scripting = scripting.api;
  const context = vm.createContext({ browser, crypto: { randomUUID }, console: { ...console, warn: () => {}, error: () => {} } });
  vm.runInContext(readScript("shared.js"), context);
  vm.runInContext(adapterSource, context);
  vm.runInContext(readScript("background.js"), context);
  await settle();
  return { browser, icons };
}

const registeredFiles = (scripting) => [...scripting.store.values()].map(({ js }) => [...js]);

test("safari background registers the preloader through the adapter", async () => {
  const scripting = createScripting();
  await startSafariBackground(scripting, {});
  assert.deepEqual(registeredFiles(scripting), [["js/shared.js", "js/resource-warmer.js", "js/preload.js"]]);
  const [script] = scripting.store.values();
  assert.equal(script.persistAcrossSessions, true);
  assert.deepEqual([...script.matches], ["http://*/*", "https://*/*"]);
});

test("safari background unregisters everything when switched off", async () => {
  const scripting = createScripting();
  const { browser, icons } = await startSafariBackground(scripting, {});
  await browser.storage.sync.set({ active: false });
  await settle();
  assert.equal(scripting.store.size, 0);
  assert.equal(icons.at(-1), "icons/rocket_da.svg");
  await browser.storage.sync.set({ active: true });
  await settle();
  assert.equal(scripting.store.size, 1);
});

test("safari background restart replaces old registrations instead of duplicating", async () => {
  const scripting = createScripting();
  const storage = {};
  await startSafariBackground(scripting, storage);
  const [firstId] = scripting.store.keys();
  await startSafariBackground(scripting, storage);
  assert.equal(scripting.store.size, 1);
  assert.notEqual([...scripting.store.keys()][0], firstId);
});

test("safari background recovers from a failed snapshot", async () => {
  const scripting = createScripting();
  const storage = {};
  await startSafariBackground(scripting, storage);
  // Restart with a failing snapshot: the old registration stays, then a later change recovers.
  scripting.fail.snapshot = 1;
  const { browser } = await startSafariBackground(scripting, storage);
  assert.equal(scripting.store.size, 1);
  await browser.storage.sync.set({ active: false });
  await settle();
  assert.equal(scripting.store.size, 0);
});

test("staged Safari extension uses the adapter and event-page manifest", () => {
  execFileSync("node", ["scripts/build-safari.mjs"], { cwd: new URL("..", import.meta.url), stdio: "pipe" });
  const staged = new URL("../build/safari-extension/", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", staged), "utf8"));
  assert.equal(manifest.background.persistent, false);
  assert.ok(manifest.permissions.includes("scripting"));
  assert.equal(manifest.browser_specific_settings, undefined);
  assert.deepEqual(manifest.background.scripts, ["js/safari-content-scripts-adapter.js", "js/shared.js", "js/background.js"]);
  assert.ok(existsSync(new URL("js/safari-content-scripts-adapter.js", staged)));
  assert.ok(!manifest.permissions.includes("privacy"));
});
