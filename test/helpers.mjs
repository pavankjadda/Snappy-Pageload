import { readFileSync } from "node:fs";
import { after } from "node:test";
import { TextDecoder } from "node:util";
import { JSDOM } from "jsdom";

// Pending jsdom timers (e.g. the 5 s prefetch wait) would otherwise keep each test file running.
const windows = [];
after(() => windows.forEach((window) => window.close()));

export function readScript(name) {
  return readFileSync(new URL(`../js/${name}`, import.meta.url), "utf8");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Lets storage events and the background's apply queue run to completion.
export const settle = () => sleep(20);

// Like storage.sync.get: an object argument supplies defaults, a key list selects stored keys.
function storageGetter(storage) {
  return async (keys) => {
    if (keys && typeof keys === "object" && !Array.isArray(keys)) return { ...keys, ...storage };
    const wanted = keys == null ? Object.keys(storage) : [keys].flat();
    return Object.fromEntries(wanted.filter((key) => key in storage).map((key) => [key, storage[key]]));
  };
}

// Fake WebExtension API for code that runs in a vm context (background.js and the Safari adapter).
// Arrays created inside the vm have that context's prototypes, so tests copy them before comparing.
export function createFakeBrowser(stored = {}) {
  const storage = stored;
  const listeners = { clicked: [], changed: [] };
  const icons = [];
  const optionsPage = { opened: 0 };
  const prediction = { value: true, levelOfControl: "controllable_by_this_extension", calls: [] };
  const browser = {
    storage: {
      sync: {
        get: storageGetter(storage),
        set: async (values) => {
          const changes = {};
          for (const [key, newValue] of Object.entries(values)) {
            changes[key] = { oldValue: storage[key], newValue };
            storage[key] = newValue;
          }
          // Firefox fires onChanged asynchronously.
          setTimeout(() => listeners.changed.forEach((listener) => listener(changes, "sync")), 0);
        },
      },
      onChanged: { addListener: (listener) => listeners.changed.push(listener) },
    },
    browserAction: {
      setIcon: ({ path }) => icons.push(path),
      setTitle: () => {},
      onClicked: { addListener: (listener) => listeners.clicked.push(listener) },
    },
    runtime: {
      onInstalled: { addListener: () => {} },
      getURL: (path) => path,
      openOptionsPage: async () => optionsPage.opened++,
    },
    tabs: { create: () => {} },
    privacy: {
      network: {
        networkPredictionEnabled: {
          get: async () => ({ value: prediction.value, levelOfControl: prediction.levelOfControl }),
          set: async ({ value }) => prediction.calls.push(["set", value]),
          clear: async () => prediction.calls.push(["clear"]),
        },
      },
    },
  };
  return { browser, storage, listeners, icons, optionsPage, prediction };
}

// Runs a content script (after js/shared.js, as registered) inside a jsdom page with a minimal
// `browser` API stub. `prefetchSupported: false` emulates Safari. Hint links never load in jsdom;
// `autoLoad` fires a load event for every <link> the script appends.
export function runContentScript(
  name,
  {
    html,
    url = "https://shop.example.test/products",
    storage = {},
    prefetchSupported = true,
    fetch: fetchImpl,
    warmPage,
    saveData = false,
    autoLoad = false,
    matchMedia,
    devicePixelRatio,
    innerWidth,
  } = {}
) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  windows.push(window);

  // jsdom has no prefetch support, IntersectionObserver or requestIdleCallback.
  window.DOMTokenList.prototype.supports = (token) => prefetchSupported && token === "prefetch";
  window.TextDecoder ??= TextDecoder;
  if (fetchImpl) window.fetch = fetchImpl;
  if (matchMedia) window.matchMedia = matchMedia;
  if (devicePixelRatio) Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: devicePixelRatio });
  if (innerWidth) Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
  if (autoLoad) {
    const appendChild = window.Node.prototype.appendChild;
    window.Node.prototype.appendChild = function (node) {
      const result = appendChild.call(this, node);
      if (node.localName === "link") setTimeout(() => node.dispatchEvent(new window.Event("load")), 0);
      return result;
    };
  }
  // `warmPage` may be true (a no-op stub) or a function; either way each call is recorded.
  const warmCalls = [];
  if (warmPage) {
    window.fasterPageloadWarmPage = async (...args) => {
      warmCalls.push(args);
      if (typeof warmPage === "function") return warmPage(...args);
    };
  }
  Object.defineProperty(window.navigator, "connection", { configurable: true, value: { saveData } });
  const observed = [];
  const observers = [];
  window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target) {
      observed.push(target);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  window.browser = { storage: { sync: { get: storageGetter(storage) } } };

  const inject = () => {
    window.eval(readScript("shared.js"));
    window.eval(readScript(name));
  };
  inject();
  return { window, document: window.document, observed, observers, inject, warmCalls };
}

export function prefetchedUrls(document) {
  return [...document.querySelectorAll('link[rel="prefetch"]')].map((link) => link.href);
}
