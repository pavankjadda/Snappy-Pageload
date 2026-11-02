# Snappy Pageload

A browser extension for **Firefox and Safari on macOS** that prepares links so a destination may be ready sooner when you open it. It preloads a same-origin link when you point at, touch or click it, and also preloads links as they scroll into view. It can also warm resources declared by those destination pages. **Chrome users should use the built-in Preload pages feature**, choosing **Standard preloading** or **Extended preloading** instead. Hover preloading does nothing in Safari (see [Browser support](#browser-support)).

Pages still load normally. The add-on starts eligible same-origin requests earlier, using the browser's `<link rel="prefetch">` (Firefox) or `<link rel="preload">` (Safari, assets only), and, for page assets, an inert HTML scan.

## Contents

- [Browser support](#browser-support)
- [Features](#features)
- [Installation](#installation)
- [Settings](#settings)
- [Checking that preloading works](#checking-that-preloading-works)
- [Troubleshooting](#troubleshooting)
- [What is not preloaded](#what-is-not-preloaded)
- [Privacy](#privacy)
- [Development](#development)
- [Credits](#credits)

## Browser support

| Browser | Support and settings |
|---|---|
| Firefox | Install from Releases or load temporarily. Open settings from `about:addons`; open developer tools with <kbd>F12</kbd>. Settings use Firefox Sync when enabled. |
| Safari on macOS | Development/testing build for macOS. It was built and tested with Safari 27.2; see the [Safari build instructions](safari/README.md). Hover preloading does nothing in Safari because Safari does not support `rel=prefetch`; visible links are only preloaded in Safari when **Include page assets** is on. Open settings in **Safari → Settings → Extensions** or from the toolbar; open Web Inspector with **Develop → Show Web Inspector**. Settings remain in local storage and do not sync. |
| Chrome | Use Chrome's built-in **Settings → Performance → Preload pages**. Choose **Standard preloading** to preload some pages you might visit, or **Extended preloading** to preload more pages with greater data use. Chrome's predictions differ from this extension's visible-link selection. [Google's instructions](https://support.google.com/chrome/answer/12929150?hl=en) |

Extension code cannot run on browser-restricted pages such as browser settings, extension stores, or built-in PDF viewers.

## Features

| Feature | Default | What it does |
|---|---|---|
| Hover, touch and click preloading | Always on | Prefetches a same-origin link 65 ms after the pointer rests on it, and immediately on touch or mouse-down. Uses `<link rel="prefetch">`, so Firefox needs `network.prefetch-next` set to true. Does nothing in Safari. |
| Preload visible links | On | Preloads eligible same-origin links as they scroll into view, including links added later, up to 30 per page you open (per page load, not per tab). |
| Include page assets | On | For each visible link, also warms the stylesheets, scripts, fonts and images declared in the destination page. See [What is not preloaded](#what-is-not-preloaded) for limits. |
| Lazy-load images | Off | Marks images with `loading="lazy"` so off-screen images load only when you scroll near them. This can alter image loading on the current page. |
| Site blacklist | Empty | Turns the add-on off completely on the listed sites. |
| On/off switch | On | **Enable Snappy Pageload** in the settings turns every feature off on all sites. The toolbar rocket is grey while it is off. Clicking the rocket opens the settings. |

## Installation

Download the appropriate asset from the [latest release](https://github.com/pavankjadda/Snappy-Pageload/releases/latest):

| Browser | Release asset | Installation type |
|---|---|---|
| Firefox | `*.xpi` | Mozilla-signed add-on for normal installation. |
| Firefox | `snappy_pageload-<version>.zip` | Unsigned build for temporary/developer installation. |
| Safari | `snappy_pageload-<version>-safari-web-extension.zip` | Web Extension resources for temporary/developer loading. |
| Safari on macOS | `Snappy-Pageload-<version>-macOS-unsigned-dev.app.zip` | Universal app for development/testing; not Developer ID-signed or notarized. |

### Firefox: from GitHub Releases

1. Download the `.xpi` file. It is signed by Mozilla. For a release published in the last few minutes, the `.xpi` may not be there yet: it is added once Mozilla has signed it. The Firefox `snappy_pageload-<version>.zip` is unsigned. It works only as a temporary add-on (see below), or in Firefox Developer Edition, Nightly or ESR with `xpinstall.signatures.required` set to `false`.
2. In Firefox, open `about:addons`, click the gear icon → **Install Add-on From File…** and choose the downloaded `.xpi`.

A setup page opens after installation. The add-on is not listed on addons.mozilla.org, so Firefox won't update it automatically: install a newer `.xpi` from Releases to update.

### Firefox: from source, temporarily

Use this to try a local checkout. Firefox removes temporary add-ons when it restarts.

1. Clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…** and select `manifest.json` in the repository folder.

Alternatively, run `pnpm install && pnpm start` (see [Development](#development)). This starts a separate Firefox profile with the add-on loaded and reloads it whenever you change a file.

Firefox 91 or newer is required.

### Safari on macOS

The Safari assets on GitHub Releases are for development and testing. They are not signed with an Apple Developer ID or notarized trusted production installers.

If Safari's **Developer** tab is hidden, enable **Safari → Settings → Advanced → Show features for web developers**.

For Safari 26 or later, download `snappy_pageload-<version>-safari-web-extension.zip`, extract it to a temporary folder, and in Safari open **Settings → Developer → Add Temporary Extension**. Enable **Allow unsigned extensions** if prompted. Safari removes a temporary extension after 24 hours or when Safari quits.

Download `Snappy-Pageload-<version>-macOS-unsigned-dev.app.zip`, extract it, copy `Snappy Pageload.app` to your personal Applications folder, launch it, then enable the extension in **Safari → Settings → Extensions**. Enable Safari's developer features and **Allow unsigned extensions**; this setting must be enabled again after each Safari restart. macOS may block an unsigned downloaded app through Gatekeeper. These development assets do not provide Apple's trusted signing/notarization status. See Apple's [running](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension) and [distributing](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension) documentation.

If macOS blocks the app because it is from an unidentified developer, first verify that you downloaded it from this repository's release. If you trust that development build, Apple's supported override is **System Settings → Privacy & Security → Open Anyway** after attempting to launch it. This approves that app without globally disabling Gatekeeper. If your Mac does not offer the override, use a locally signed build instead. [Apple's instructions](https://support.apple.com/en-us/102445)

## Settings

Click the rocket in the toolbar to open settings. Alternatively:

- **Firefox:** `about:addons` → **Snappy Pageload** → **Preferences**.
- **Safari:** **Safari → Settings → Extensions → Snappy Pageload → Settings**.

Changes take effect when you click **Save settings**.

- **Enable Snappy Pageload.** On by default. Turning it off stops every feature on all sites, and the toolbar rocket turns grey.

- **Preload visible links.** On by default; only an explicitly saved "off" disables it. Same-origin links that scroll into view (including links added later) are prepared, up to 30 per page you open. Links with query strings, `rel="ugc"`/`nofollow` links, links in comment sections and unsafe-looking URLs are skipped. In Firefox the page is prefetched with `<link rel="prefetch">`, which needs `network.prefetch-next` set to true. Neither desktop Firefox nor Safari tells extensions about a data-saver setting, so there is no automatic data-saver skip.
- **Include page assets.** On by default; only an explicitly saved "off" disables it. For each visible link, the destination's HTML is read without running its scripts, and its stylesheets (and `@import`s), scripts (classic and module, not `nomodule`), fonts, preloaded resources and up to 6 images are warmed. Firefox uses low-priority `<link rel="prefetch">` hints; Safari uses `<link rel="preload">`, the only kind Safari reuses. In Safari, visible links do nothing unless this option is on. See [What is not preloaded](#what-is-not-preloaded) for details.
- **Hover, touch and click preloading** has no setting: it is always on while the add-on is enabled. Hovering preloads a link after 65 ms; touch and mouse-down preload it immediately. Hover allows links with query strings; the unsafe-link rules below still apply. It does nothing in Safari.
- **Lazy-load images.** Saves bandwidth on long, image-heavy pages. Images that already set their own `loading` attribute are left alone. This can change image loading on the current page.
- **Blacklist sites.** A comma-separated list of sites where the add-on should do nothing.
  - `www.example.com` matches exactly that host.
  - `*.example.com` matches `example.com` and all its subdomains.
  - You can paste a full URL such as `https://example.com:8080/path`. It is reduced to the host (`example.com`). Ports are ignored.
  - International domain names are stored in their punycode form.
  - If any entry is invalid, nothing is saved and the invalid entries are listed next to the **Save** button.

The settings page is responsive and follows your system light or dark theme. Changes apply straight away to pages you load afterwards. Pages that are already open keep their old behaviour until you reload them.

## Checking that preloading works

Preloading happens in the background, so there is nothing to see on the page itself. To check it:

1. Open a site with internal links, for example a news site or documentation pages.
2. Open Firefox developer tools (<kbd>F12</kbd>), or Safari's **Develop → Show Web Inspector**, and go to the **Network** tab.
3. Rest the pointer on a link to another page on the **same origin** for a moment (Firefox only). Check the Network tab for a prefetch request for that page.
4. Alternatively, scroll until an eligible link to another page on the same origin enters view. Check the Network tab for the early destination request. The extension may also request the destination's declared assets.
5. Open the destination link and check whether the browser reuses the page and asset responses in the **Network** tab. Cache reuse depends on the browser and the site's response headers; an early request alone does not prove that navigation will be faster. In one local Safari check, Safari fetched the destination HTML again on navigation; see [Safari build instructions](safari/README.md).

If the destination is not requested, see [Troubleshooting](#troubleshooting) and [What is not preloaded](#what-is-not-preloaded).

## Troubleshooting

**A visible link is not preloaded.**

- Check that the toolbar rocket is coloured, not grey. A grey rocket means the add-on is switched off: click it and turn on **Enable Snappy Pageload**.
- Check that the site is not in your blacklist.
- In Firefox, open `about:config` and check that `network.prefetch-next` is `true`. It is the default, but arkenfox, LibreWolf and some enterprise policies turn it off. Hover and visible-link preloading use `<link rel="prefetch">` and are silently ignored when it is off.
- In Safari, enable the extension and grant it access to the website in **Settings → Extensions**. Unsigned development builds also require **Allow unsigned extensions** after restarting Safari.
- Reload the tab. Tabs opened before the add-on was installed, enabled or changed don't have the preloader yet.
- Make sure the link goes to the same origin (same scheme, host and port) and is not marked as user-generated content. Visible-link preloading also skips links with a query string; hover does not. See [What is not preloaded](#what-is-not-preloaded).
- Content scripts cannot run on browser-restricted pages. Firefox examples include `about:` pages, `addons.mozilla.org`, the built-in PDF viewer and reader view; Safari also restricts its internal pages.

**A request appears, but the page is not faster.**

- The site may send `Cache-Control: no-store` or other headers that prevent response reuse. The add-on cannot change those rules.
- Cache reuse depends on Firefox or Safari and the site's response headers. An early download does not guarantee that a later navigation will use it or feel faster.
- Browser scheduling may delay or skip preload requests. The add-on does not detect data-saver modes, because neither desktop Firefox nor Safari reports one to extensions.

**Image lazy loading doesn't seem to change anything.**

The extension sets `loading="lazy"` on images while the page is loading. Browsers often start downloading images from the original HTML before an extension can change them, so on many pages the option only affects images that are added later. Pages that already lazy-load their images won't show a difference either.

## What is not preloaded

To limit unnecessary requests and side effects, the add-on always skips these links:

- **Links to other origins.** Only links with the same scheme, host and port are eligible.
- **Links that look like they change something on the server.** Prefetching a logout link would log you out, and prefetching a vote link would cast the vote. These links are skipped if the URL contains any of:
  - `logout`, `log_out`, `sign-out`, `signoff`
  - `delete`, `destroy`, `remove`, `revoke`, `cancel`, `disconnect`
  - `subscribe`, `unsubscribe`, `follow`, `unfollow`, `vote`, `like`, `unlike`
  - `approve`, `confirm`, `accept`, `reject`, `archive`, `toggle`, `token`
  - `mark-as-read` and similar
  - `add-to-cart` and similar

  This list is a heuristic, so some harmless links are skipped too. It can't catch every action link a site might have.
- **Links with query strings, when preloading visible links.** Query parameters often identify actions or personalized pages. Hover preloading allows them; the other rules here still apply.
- **Links marked `rel="ugc"` or `rel="nofollow"`,** and links inside comment sections (`#comments`, `.comments`, `.comment`, `[itemprop="comment"]`), when preloading visible links.
- **Links to the current page,** including `#section` anchors.
- **Download links** (`<a download>`), and links that are not `http`/`https` (`mailto:`, `javascript:`, …).
- **Links the site marked with `data-no-instant`.** This is the same opt-out attribute that instant.page uses.
- **HTTP links on HTTPS pages,** since they are a different origin.

**Page assets.** The destination page scan is inert: its scripts are not executed. These are skipped:

- Resources loaded later by scripts, and anything inside `<noscript>`.
- Background images inside stylesheets.
- Lazy images, tracking pixels, and all but one candidate per `<picture>`/`srcset`. At most 6 images are warmed (including poster images and inline style backgrounds).
- Fonts other than the first format listed in each `@font-face`, and language subsets that the page's text does not use.
- `nomodule` scripts.
- Any asset whose URL looks like an action, tracker, pixel, beacon, analytics, counter, captcha or ad.

**Limits.** 20 assets per destination page, 100 per page you open, at most 4 requests at a time, HTML up to 2 MiB and CSS up to 512 KiB. The limit of 30 destination pages applies per page load, separately. Speculative HTML and CSS requests carry `X-Moz: prefetch` and `Purpose: prefetch` headers so sites can recognise them. Cache reuse depends on response headers and browser behavior, and has not been established as a measurable speedup for every site. A resource sent with `Cache-Control: no-store` may still be reused by the browser, so it can be up to one page view stale.

## Privacy

- The add-on collects no telemetry and has no collection server. It requests destination pages on your current origin. Asset preloading can also contact third-party hosts referenced by those pages, such as font and image CDNs, using browser-native requests subject to the site's security policy.
- The blacklist is applied both when the scripts are registered and again inside the scripts, as a safety net because Safari may ignore `excludeMatches`.
- Settings use `storage.sync`: they follow your Firefox account when Firefox Sync is enabled. Safari implements this storage locally and does not sync it between devices.
- Preloading means sites and referenced resource hosts can see early requests even if you never open the destination page. If that matters for a site, add it to the blacklist.
- Permissions:
  - `storage`, to save settings.
  - `http://*/*` and `https://*/*`, so the preloader can run on the web pages you visit.
  - The Safari build additionally uses `scripting`, to register its content scripts.

## Development

For a local macOS Safari build, see [Safari build instructions](safari/README.md).

### Requirements

- Node.js 24 or newer.
- [pnpm](https://pnpm.io/).
- Firefox, for `pnpm start`.
- macOS and full Xcode for Safari app builds; see [Safari build instructions](safari/README.md).
- `zip` and `unzip` for `pnpm package:safari` (included on macOS and the Ubuntu release runner).

### Commands

```sh
pnpm install     # install dev dependencies (jsdom, web-ext)
pnpm test        # run the unit tests (node:test + jsdom)
pnpm lint        # Mozilla's add-on linter (web-ext lint)
pnpm start       # launch Firefox with the add-on, reloads on file changes
pnpm package     # test + lint + build web-ext-artifacts/snappy_pageload-<version>.zip
pnpm package:safari # stage and zip Safari Web Extension resources
make store       # same as pnpm package
make clean       # remove build output
```

`web-ext-config.mjs` controls which files are left out of the packaged zip: tests, tooling and docs.

### Project layout

```
manifest.json         Manifest V2 add-on manifest
js/background.js      Reads settings, registers content scripts, opens settings from the toolbar
js/preload.js         Content script (document_idle): hover/touch/click and visible-link preloading
js/resource-warmer.js Content script helper: inert destination HTML and declared-asset warming
js/lazy_images.js     Content script (document_start): adds loading="lazy" to images
js/options.js         Settings page logic, validates the blacklist
options.html          Settings page structure
options.css           Responsive light/dark settings page styles
static/setup.html     Page shown after installation
icons/                Toolbar icons (rocket.svg = on, rocket_da.svg = off)
test/                 Unit tests
safari/               Safari registration adapter, setup page and build instructions
scripts/              Safari staging, native app builds and release packaging
```

### How it works

- **No static content scripts.** The background registers content scripts at runtime with Firefox's `browser.contentScripts.register`. The Safari adapter uses `browser.scripting.registerContentScripts`. When the extension is off, nothing is injected into new pages. The blacklist becomes `excludeMatches` patterns and is also checked inside the content scripts.
- **Settings apply without a reload.** Any change to the settings (`storage.onChanged`) re-registers the scripts. The new registrations are added before the old ones are removed, so no page loads without the scripts during the switch.
- **Preloading.** `preload.js` prefetches a same-origin link shortly after the pointer rests on it (65 ms), and immediately on touch or mouse-down. It also observes eligible same-origin links as they enter view and enforces the 30-per-page-load limit. It skips unsafe-looking URLs, and for visible links also query strings and user-generated content. `resource-warmer.js` fetches destination HTML without running its scripts and warms a bounded set of statically declared assets. Browser cache reuse depends on the browser and response headers.

### Releasing

1. Bump `version` in both `manifest.json` and `package.json`. AMO signs each version only once.
2. Add an entry to `CHANGELOG.md`, commit and push.
3. Publish a GitHub release with the tag `v<version>` (for example `v2.1.0`).

The [Release workflow](.github/workflows/release.yml) validates the release first, then runs the Safari app build and Mozilla signing independently:

1. **Ubuntu build:** checks that the tag matches the version in `manifest.json`, runs tests and lint, then attaches `snappy_pageload-<version>.zip` (unsigned Firefox build) and `snappy_pageload-<version>-safari-web-extension.zip` (Safari web extension resources, with the manifest at the archive root).
2. **macOS Safari app:** builds a universal (arm64 and x86_64), ad-hoc-signed Release app, then attaches `Snappy-Pageload-<version>-macOS-unsigned-dev.app.zip`. It is a development/testing asset, not a Developer ID-signed or notarized production installer.
3. **Mozilla signing:** submits the Firefox add-on to addons.mozilla.org on the unlisted channel (not public), waits for the signature (usually a few minutes), and attaches the signed `.xpi`. AMO signing credentials are separate from Safari packaging. If they are missing, the unsigned Firefox zip and Safari assets are still uploaded; macOS build and AMO signing failures are independent after the Ubuntu build.

One-time setup: add the AMO API credentials (addons.mozilla.org → Developer Hub → Tools → Manage API Keys) as repository secrets `AMO_API_KEY` (JWT issuer) and `AMO_API_SECRET` (JWT secret). Without them the workflow still attaches the unsigned Firefox zip and Safari assets, but no `.xpi`. Safari CI uses no personal Mac certificate or Apple credentials; production signing and notarization are not implemented.

To sign locally instead, put `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` in `.env.local` (git-ignored) and run `pnpm sign`.

To rebuild files for a release whose tag contains this tooling, run the workflow manually from the **Actions** tab and enter the tag. Tags predating Safari packaging do not contain its build scripts and require their historical workflow or a new release tag.

## Credits

- Snappy Pageload started as a fork of [Faster Pageload](https://github.com/simonfrey/faster-pageload-web-extensions) by Simon Frey ([MIT license](LICENSE)).
- The preloading approach is based on [instant.page](https://instant.page/) by Alexandre Dieulot ([MIT license](https://opensource.org/licenses/MIT)).
