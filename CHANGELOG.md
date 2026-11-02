# Changelog

## Unreleased

- Changed: the add-on is now called Snappy Pageload, with a new rocket icon. The add-on ID is unchanged, so installed copies keep their settings.
- Changed: clicking the toolbar rocket opens the settings page instead of switching the add-on off. The on/off switch is now **Enable Snappy Pageload** in the settings, and the rocket still turns grey while it is off.
- Added: "Preload visible links" and "Include page assets", both on by default (only an explicitly saved "off" disables them). Same-origin links that scroll into view, including links added later, are preloaded, up to 30 per page you open. Visible links skip query strings, `rel="ugc"`/`nofollow` links and comment sections.
- Added: with "Include page assets", each visible link's destination HTML is read without running its scripts, and its stylesheets, scripts, fonts, preloaded resources and up to 6 images are warmed. Limits: 20 assets per destination, 100 per page you open, 4 requests at a time, HTML up to 2 MiB, CSS up to 512 KiB.
- Added: a local Safari build (development/testing, unsigned) with the same settings. In Safari, assets are warmed with `<link rel="preload">`, and visible links do nothing unless "Include page assets" is on. Built and tested with Safari 27.2.
- Changed: hover, touch and click preloading is kept and always on: a same-origin link is prefetched 65 ms after the pointer rests on it, immediately on touch and on mouse-down. It needs `network.prefetch-next` in Firefox and does nothing in Safari.
- Changed: asset safety rules. Lazy images, tracking pixels, `nomodule` scripts, `<noscript>` content, background images inside stylesheets, extra `@font-face` formats and unused font language subsets are not warmed, nor are assets whose URL looks like an action, tracker, pixel, beacon, analytics, counter, captcha or ad.
- Changed: in Firefox, assets are warmed with low-priority `<link rel="prefetch">` hints.
- Changed: speculative HTML and CSS requests carry `X-Moz: prefetch` and `Purpose: prefetch` headers so sites can recognise them.
- Fixed: the site blacklist is now also checked inside the content scripts, as a safety net because Safari may ignore `excludeMatches`.

## 2.0.0

- Fixed: links are now preloaded on most sites. The bundled instant.page script only preloaded same-origin links without query strings, so most links were skipped. It has been replaced by a built-in preloader that also handles query strings and skips links that look like actions (logout, delete, vote, like, follow, mark-as-read, add-to-cart, …).
- Fixed: "Preload every visible link" now works. The option was saved but never read. It is off by default, because prefetching without any user signal can trigger links that perform actions. When on, it preloads up to 30 visible links per page, including links added after the page loads, and skips links with query strings, links marked `rel="ugc"`/`nofollow`, and links in comment sections.
- Fixed: the toolbar on/off switch and the site blacklist now apply to preloading as well, not only to image lazy loading.
- Fixed: pages no longer throw an error when no blacklist has been saved yet.
- Changed: blacklist entries are validated when you save. Pasted URLs are reduced to their host, wildcard entries such as `*.example.com` are supported, and invalid entries are shown instead of being ignored without notice.
- Changed: image lazy loading now uses the browser's native `loading="lazy"`, applied while the page loads. The old approach delayed image requests for up to 15 seconds and shared state between tabs.
- Changed: settings apply immediately without reloading the add-on. Scripts are only re-registered when the on/off state, lazy loading or the blacklist changes, and a page can't run them twice during the switch.
- Fixed: a link that changes or disappears during the hover delay is no longer prefetched; only the URL that passed the safety checks is fetched.
- Changed: the `webRequest`, `webRequestBlocking` and `web_accessible_resources` entries were removed from the manifest because they are no longer needed, and `<all_urls>` was narrowed to `http://*/*` and `https://*/*`.
- Changed: the setup page now points to the setting that controls prefetching (`network.prefetch-next`).
