import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createFakeBrowser, readScript, settle } from "./helpers.mjs";

// Loads background.js against a fake WebExtension API and returns the recorded calls.
async function loadBackground(stored = {}, { failLazyRegistration = false, withoutPrivacy = false, levelOfControl, prefetchFails = false } = {}) {
  const fake = createFakeBrowser(stored);
  const { browser } = fake;
  if (withoutPrivacy) delete browser.privacy;
  if (levelOfControl) fake.prediction.levelOfControl = levelOfControl;
  if (prefetchFails) {
    browser.privacy.network.networkPredictionEnabled.get = async () => {
      throw new Error("privacy failed");
    };
  }
  const registered = [];
  const registerAttempts = [];
  const fail = { lazyRegistration: failLazyRegistration };

  browser.contentScripts = {
    register: async (options) => {
      registerAttempts.push(options.js.at(-1).file);
      if (fail.lazyRegistration && options.js.at(-1).file === "js/lazy_images.js") throw new Error("register failed");
      const registration = { options, active: true, unregister: async () => (registration.active = false) };
      registered.push(registration);
      return registration;
    },
  };

  const warnings = [];
  const context = vm.createContext({ browser, console: { ...console, warn: (...args) => warnings.push(args.join(" ")), error: () => {} } });
  vm.runInContext(readScript("shared.js"), context);
  vm.runInContext(readScript("background.js"), context);
  await settle();

  // Arrays created inside the vm context have a different prototype; copy them into this realm.
  const activeScripts = () =>
    registered
      .filter((registration) => registration.active)
      .map(({ options }) => ({
        file: options.js.at(-1).file,
        files: Array.from(options.js, ({ file }) => file),
        runAt: options.runAt,
        matches: [...options.matches],
        excludeMatches: options.excludeMatches && [...options.excludeMatches],
      }));

  return { ...fake, fail, activeScripts, registered, registerAttempts, warnings };
}

test("defaults register only the preloader", async () => {
  const { activeScripts, icons } = await loadBackground();
  assert.deepEqual(activeScripts(), [
    {
      file: "js/preload.js",
      files: ["js/shared.js", "js/resource-warmer.js", "js/preload.js"],
      runAt: "document_idle",
      matches: ["http://*/*", "https://*/*"],
      excludeMatches: undefined,
    },
  ]);
  assert.equal(icons.at(-1), "icons/rocket.svg");
});

test("lazy loading registers the image script at document_start", async () => {
  const { activeScripts } = await loadBackground({ imgLazyLoad: true });
  assert.deepEqual(
    activeScripts().map(({ file, runAt }) => [file, runAt]),
    [
      ["js/preload.js", "document_idle"],
      ["js/lazy_images.js", "document_start"],
    ]
  );
  assert.deepEqual(activeScripts()[1].files, ["js/lazy_images.js"]);
});

test("blacklisted hosts are excluded from every script and invalid entries are dropped", async () => {
  const { activeScripts, warnings } = await loadBackground({
    imgLazyLoad: true,
    blacklistSites: "www.example.test, *.news.example.test,https://bad/entry,,",
  });
  for (const script of activeScripts()) {
    assert.deepEqual(script.excludeMatches, ["*://www.example.test/*", "*://*.news.example.test/*"]);
  }
  assert.ok(warnings.some((warning) => warning.includes("https://bad/entry")));
});

test("clicking the toolbar button opens the settings page without switching anything off", async () => {
  const { listeners, storage, activeScripts, optionsPage } = await loadBackground();
  listeners.clicked[0]();
  await settle();
  assert.equal(optionsPage.opened, 1);
  assert.equal(storage.active, undefined);
  assert.equal(activeScripts().length, 1);
});

test("the on/off switch in settings applies through storage.onChanged", async () => {
  const { browser, activeScripts, icons } = await loadBackground({ imgLazyLoad: true });

  await browser.storage.sync.set({ active: false });
  await settle();
  assert.deepEqual(activeScripts(), []);
  assert.equal(icons.at(-1), "icons/rocket_da.svg");

  await browser.storage.sync.set({ active: true });
  await settle();
  assert.equal(activeScripts().length, 2);
  assert.equal(icons.at(-1), "icons/rocket.svg");
});

test("a failed registration keeps the previous scripts and rolls back the partial new set", async () => {
  const { storage, fail, listeners, registered, registerAttempts, activeScripts } = await loadBackground();
  const original = registered[0];
  fail.lazyRegistration = true;
  storage.imgLazyLoad = true;
  listeners.changed.forEach((listener) => listener({ imgLazyLoad: { oldValue: undefined, newValue: true } }, "sync"));
  await settle();

  assert.deepEqual(registerAttempts, ["js/preload.js", "js/preload.js", "js/lazy_images.js"]);
  assert.equal(original.active, true, "the original registration must survive");
  assert.equal(registered[1].active, false, "the partial replacement must be unregistered");
  assert.deepEqual(
    activeScripts().map(({ file }) => file),
    ["js/preload.js"]
  );
});

test("changes that don't affect registration don't re-register", async () => {
  const { storage, listeners, registerAttempts, registered } = await loadBackground();
  storage.preloadViewport = true;
  listeners.changed.forEach((listener) => listener({ preloadViewport: { oldValue: undefined, newValue: true } }, "sync"));
  await settle();
  assert.deepEqual(registerAttempts, ["js/preload.js"]);
  assert.equal(registered[0].active, true);
});

test("built-in prefetching is turned on by default", async () => {
  const { prediction } = await loadBackground();
  assert.deepEqual(prediction.calls, [["set", true]]);
});

test("built-in prefetching is cleared when its setting is off", async () => {
  const { prediction } = await loadBackground({ browserPrefetch: false });
  assert.deepEqual(prediction.calls, [["clear"]]);
});

test("built-in prefetching is cleared when the extension is off", async () => {
  const { prediction } = await loadBackground({ active: false });
  assert.deepEqual(prediction.calls, [["clear"]]);
});

test("built-in prefetching is left alone when another extension or policy controls it", async () => {
  const { prediction, warnings, activeScripts } = await loadBackground({}, { levelOfControl: "not_controllable" });
  assert.deepEqual(prediction.calls, []);
  assert.equal(warnings.filter((warning) => warning.includes("another extension or policy")).length, 1);
  assert.equal(activeScripts().length, 1);
});

test("a missing privacy API (Safari) doesn't break script registration", async () => {
  const { activeScripts, prediction } = await loadBackground({}, { withoutPrivacy: true });
  assert.equal(activeScripts().length, 1);
  assert.deepEqual(prediction.calls, []);
});

test("a failing privacy API doesn't break script registration", async () => {
  const { activeScripts } = await loadBackground({}, { prefetchFails: true });
  assert.equal(activeScripts().length, 1);
});

test("set and clear are not repeated on unrelated setting changes", async () => {
  const { browser, prediction } = await loadBackground();
  await browser.storage.sync.set({ preloadViewport: false });
  await settle();
  await browser.storage.sync.set({ blacklistSites: "example.test" });
  await settle();
  assert.deepEqual(prediction.calls, [["set", true]]);

  await browser.storage.sync.set({ browserPrefetch: false });
  await settle();
  await browser.storage.sync.set({ imgLazyLoad: true });
  await settle();
  assert.deepEqual(prediction.calls, [["set", true], ["clear"]]);
});
