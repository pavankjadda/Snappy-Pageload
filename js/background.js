"use strict";

const DEFAULT_SETTINGS = {
  active: true,
  imgLazyLoad: false,
  preloadViewport: true,
  preloadAssets: true,
  blacklistSites: "",
};

// "example.com", "www.example.com" or "*.example.com"; anything else is not a valid match-pattern host.
// options.js validates with the same pattern; this is the safety net for older stored values.
const BLACKLIST_HOST = /^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

// Only web pages; the preloader has nothing to do on file:, ftp: or other schemes.
const WEB_PAGES = ["http://*/*", "https://*/*"];
const contentScriptAPI = globalThis.fasterPageloadContentScripts ?? browser.contentScripts;

let registeredScripts = [];
// Identifies the configuration behind registeredScripts, so unrelated setting changes
// (e.g. preloadViewport, which preload.js reads itself) don't trigger a re-registration.
let registeredConfig = null;
let applyQueue = Promise.resolve();

async function getSettings() {
  const stored = await browser.storage.sync.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...stored };
}

function toExcludeMatches(blacklistSites) {
  return blacklistSites
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => {
      if (BLACKLIST_HOST.test(host)) return true;
      if (host) console.warn(`[snappy pageload] Ignoring invalid blacklist entry: ${host}`);
      return false;
    })
    .map((host) => `*://${host}/*`);
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
          js: [{ file: "js/resource-warmer.js" }, { file: "js/preload.js" }],
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
    // Safari event pages can restart while earlier registrations remain active.
    // Keep them until the complete replacement has been registered successfully.
    await contentScriptAPI.finishUpdate?.();
  } catch (error) {
    await Promise.allSettled(next.map((script) => script.unregister()));
    throw error;
  }

  registeredScripts = next;
  registeredConfig = config;
  await Promise.allSettled(previous.map((script) => script.unregister()));
}

// Serializes setting changes and toggles so concurrent events can't interleave.
function enqueue(task) {
  applyQueue = applyQueue
    .then(task)
    .catch((error) => console.error("[snappy pageload] Failed to apply settings:", error));
  return applyQueue;
}

function applySettings() {
  return enqueue(async () => {
    const settings = await getSettings();
    updateBrowserAction(settings.active);
    await registerContentScripts(settings);
  });
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
