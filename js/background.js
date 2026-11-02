"use strict";

const { DEFAULT_SETTINGS, blacklistEntries } = globalThis.snappyPageload;

// Only web pages; the preloader has nothing to do on file:, ftp: or other schemes.
const WEB_PAGES = ["http://*/*", "https://*/*"];
const contentScriptAPI = globalThis.fasterPageloadContentScripts ?? browser.contentScripts;

let registeredScripts = [];
// Identifies the configuration behind registeredScripts, so unrelated setting changes
// (e.g. preloadViewport, which preload.js reads itself) don't trigger a re-registration.
let registeredConfig = null;
// "set" or "clear" once applied to privacy.network.networkPredictionEnabled; null until the first run.
let appliedPrediction = null;
let applyQueue = Promise.resolve();

function getSettings() {
  return browser.storage.sync.get(DEFAULT_SETTINGS);
}

function toExcludeMatches(blacklistSites) {
  const { hosts, invalid } = blacklistEntries(blacklistSites);
  for (const host of invalid) console.warn(`[snappy pageload] Ignoring invalid blacklist entry: ${host}`);
  return hosts.map((host) => `*://${host}/*`);
}

function updateBrowserAction(active) {
  browser.browserAction.setIcon({ path: active ? "icons/rocket.svg" : "icons/rocket_da.svg" });
  browser.browserAction.setTitle({
    title: active ? "Snappy Pageload is on. Click for settings." : "Snappy Pageload is off. Click for settings.",
  });
}

// Content scripts are registered at runtime so that the on/off switch and the blacklist
// apply to every feature, and setting changes take effect without reloading the extension.
// The new set is registered before the old one is removed, so pages never load without scripts,
// and a failed registration leaves the previous set in place.
async function registerContentScripts(settings) {
  const excludeMatches = toExcludeMatches(settings.blacklistSites);
  const config = JSON.stringify({ active: settings.active, imgLazyLoad: settings.imgLazyLoad, excludeMatches });
  if (config === registeredConfig) return;

  const previous = registeredScripts;
  const next = [];

  try {
    if (settings.active) {
      const target = { matches: WEB_PAGES };
      if (excludeMatches.length > 0) target.excludeMatches = excludeMatches;

      next.push(
        await contentScriptAPI.register({
          ...target,
          js: [{ file: "js/shared.js" }, { file: "js/resource-warmer.js" }, { file: "js/preload.js" }],
          runAt: "document_idle",
        })
      );

      if (settings.imgLazyLoad) {
        next.push(
          await contentScriptAPI.register({
            ...target,
            js: [{ file: "js/lazy_images.js" }],
            runAt: "document_start",
          })
        );
      }
    }
    // Commit point for adapters: the complete replacement is registered at this point.
    await contentScriptAPI.finishUpdate?.();
  } catch (error) {
    await Promise.allSettled(next.map((script) => script.unregister()));
    throw error;
  }

  registeredScripts = next;
  registeredConfig = config;
  await Promise.allSettled(previous.map((script) => script.unregister()));
}

// Firefox maps this setting to network.prefetch-next, DNS prefetching and the network predictor,
// so turning it on restores link prefetching even when a privacy setup disabled it. Clearing it
// hands control back to the user's own setting. Absent in Safari.
async function applyBrowserPrefetch(settings) {
  const prediction = browser.privacy?.network?.networkPredictionEnabled;
  if (!prediction) return;

  const desired = settings.active && settings.browserPrefetch ? "set" : "clear";
  if (desired === appliedPrediction) return;

  try {
    if (desired === "set") {
      const { levelOfControl } = await prediction.get({});
      if (levelOfControl === "controllable_by_this_extension" || levelOfControl === "controlled_by_this_extension") {
        await prediction.set({ value: true });
      } else {
        console.warn("[snappy pageload] Cannot enable built-in prefetching: another extension or policy controls it.");
      }
    } else {
      await prediction.clear({});
    }
    appliedPrediction = desired;
  } catch (error) {
    console.error("[snappy pageload] Failed to update built-in prefetching:", error);
  }
}

// Serializes setting changes and toggles so concurrent events can't interleave.
function applySettings() {
  applyQueue = applyQueue
    .then(async () => {
      const settings = await getSettings();
      updateBrowserAction(settings.active);
      await applyBrowserPrefetch(settings);
      await registerContentScripts(settings);
    })
    .catch((error) => console.error("[snappy pageload] Failed to apply settings:", error));
  return applyQueue;
}

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.tabs.create({ url: browser.runtime.getURL("static/setup.html") });
  }
});

// The toolbar button opens the settings page, which holds the on/off switch.
browser.browserAction.onClicked.addListener(() => browser.runtime.openOptionsPage());

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync") applySettings();
});

applySettings();
