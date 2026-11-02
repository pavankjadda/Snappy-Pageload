import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

export function readScript(name) {
  return readFileSync(new URL(`../js/${name}`, import.meta.url), "utf8");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `prefetchSupported` controls relList.supports("prefetch") (false emulates Safari).
// Runs a content script inside a jsdom page with a minimal `browser` API stub.
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
  } = {}
) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;

  // jsdom has no prefetch support, IntersectionObserver or requestIdleCallback.
  window.DOMTokenList.prototype.supports = (token) => prefetchSupported && token === "prefetch";
  if (fetchImpl) window.fetch = fetchImpl;
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
  window.browser = { storage: { sync: { get: async () => ({ ...storage }) } } };

  const inject = () => window.eval(readScript(name));
  inject();
  return { window, document: window.document, observed, observers, inject, warmCalls };
}

export function prefetchedUrls(document) {
  return [...document.querySelectorAll('link[rel="prefetch"]')].map((link) => link.href);
}
