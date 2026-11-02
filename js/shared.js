"use strict";

// Settings defaults and link rules used by the background script, the settings page and the
// content scripts. Content scripts can be injected twice while registrations are swapped, so
// nothing is declared at the top level and the first copy is kept.
globalThis.snappyPageload ??= (() => {
  const DEFAULT_SETTINGS = {
    active: true,
    imgLazyLoad: false,
    preloadViewport: true,
    preloadAssets: true,
    browserPrefetch: true,
    blacklistSites: "",
  };

  // GET links that commonly change state on the server must never be fetched speculatively.
  // False positives only cost a missed prefetch, so this errs on the side of skipping.
  const UNSAFE_LINK = new RegExp(
    [
      "(log|sign)[-_ ]?(out|off)",
      "delete|destroy|remove|revoke|cancel|disconnect",
      "subscribe|\\bfollow\\b|unfollow|vote|\\blike\\b|unlike",
      "approve|confirm|accept|reject|archive|toggle|token",
      "mark[-_]?(as[-_]?)?(read|unread|seen|done)",
      "add[-_]?to[-_]?(cart|basket|bag)",
    ].join("|"),
    "i"
  );

  // "example.com", "www.example.com" or "*.example.com"; anything else is not a valid match-pattern host.
  const BLACKLIST_HOST = /^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

  // Accepts an <a> element or a URL.
  function decodedPathAndQuery({ pathname, search }) {
    const raw = pathname + search;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function isUnsafePath(target) {
    return UNSAFE_LINK.test(decodedPathAndQuery(target));
  }

  // Splits a stored blacklist into valid lowercase hosts and the entries that are not valid.
  function blacklistEntries(blacklistSites) {
    const hosts = [];
    const invalid = [];
    for (const entry of String(blacklistSites ?? "").split(",")) {
      const host = entry.trim().toLowerCase();
      if (BLACKLIST_HOST.test(host)) hosts.push(host);
      else if (host) invalid.push(host);
    }
    return { hosts, invalid };
  }

  // "example.com" matches only that host; "*.example.com" also matches every subdomain.
  function isBlacklisted(hostname, blacklistSites) {
    const host = hostname.toLowerCase();
    return blacklistEntries(blacklistSites).hosts.some((entry) => {
      if (!entry.startsWith("*.")) return host === entry;
      const base = entry.slice(2);
      return host === base || host.endsWith(`.${base}`);
    });
  }

  // Resolves once a <link> fires load or error, or after timeoutMs, whichever comes first.
  function linkSettled(link, timeoutMs) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        link.removeEventListener("load", done);
        link.removeEventListener("error", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      link.addEventListener("load", done);
      link.addEventListener("error", done);
    });
  }

  return {
    DEFAULT_SETTINGS,
    UNSAFE_LINK,
    BLACKLIST_HOST,
    decodedPathAndQuery,
    isUnsafePath,
    blacklistEntries,
    isBlacklisted,
    linkSettled,
  };
})();
