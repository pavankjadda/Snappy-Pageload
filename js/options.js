"use strict";

const activeElement = document.getElementById("active");
const preloadViewportElement = document.getElementById("preloadViewport");
const preloadAssetsElement = document.getElementById("preloadAssets");
const browserPrefetchElement = document.getElementById("browserPrefetch");
const imgLazyLoadElement = document.getElementById("imgLazyLoad");
const blacklistSitesElement = document.getElementById("blacklistSites");
const statusElement = document.getElementById("status");

const { DEFAULT_SETTINGS, BLACKLIST_HOST } = globalThis.snappyPageload;

// The privacy API does not exist in Safari, so the setting would do nothing there.
if (!browser.privacy) document.getElementById("browserPrefetch-row").style.display = "none";

// Accepts "example.com", "*.example.com" or a pasted URL such as "https://example.com:8080/path"
// and reduces it to the host. Ports are dropped because match patterns cannot express them.
function normalizeHost(entry) {
  const wildcard = entry.startsWith("*.") ? "*." : "";
  const rest = wildcard ? entry.slice(2) : entry;
  try {
    const { hostname } = new URL(rest.includes("://") ? rest : `http://${rest}`);
    const host = wildcard + hostname;
    return BLACKLIST_HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

function parseBlacklist(value) {
  const hosts = [];
  const invalid = [];
  for (const entry of value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const host = normalizeHost(entry);
    if (host) {
      if (!hosts.includes(host)) hosts.push(host);
    } else {
      invalid.push(entry);
    }
  }
  return { hosts, invalid };
}

async function saveOptions(event) {
  event.preventDefault();
  const { hosts, invalid } = parseBlacklist(blacklistSitesElement.value);
  if (invalid.length > 0) {
    statusElement.textContent = `Not saved. Invalid blacklist entries: ${invalid.join(", ")}`;
    return;
  }
  const blacklistSites = hosts.join(",");
  try {
    // The background script picks the change up via storage.onChanged; no reload needed.
    await browser.storage.sync.set({
      active: activeElement.checked,
      preloadViewport: preloadViewportElement.checked,
      preloadAssets: preloadAssetsElement.checked,
      browserPrefetch: browserPrefetchElement.checked,
      imgLazyLoad: imgLazyLoadElement.checked,
      blacklistSites,
    });
    blacklistSitesElement.value = blacklistSites;
    statusElement.textContent = "Saved. Applies to pages loaded from now on.";
  } catch (error) {
    statusElement.textContent = `Could not save settings: ${error}`;
  }
}

async function restoreOptions() {
  try {
    const settings = await browser.storage.sync.get(DEFAULT_SETTINGS);
    activeElement.checked = settings.active;
    preloadViewportElement.checked = settings.preloadViewport;
    preloadAssetsElement.checked = settings.preloadAssets;
    browserPrefetchElement.checked = settings.browserPrefetch;
    imgLazyLoadElement.checked = settings.imgLazyLoad;
    blacklistSitesElement.value = settings.blacklistSites;
  } catch (error) {
    statusElement.textContent = `Could not load settings: ${error}`;
  }
}

document.addEventListener("DOMContentLoaded", restoreOptions);
document.querySelector("form").addEventListener("submit", saveOptions);
