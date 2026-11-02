# Safari development and testing builds

The Safari adapter shares the Firefox runtime and adds Safari-specific script registration. The shared `js/shared.js` (settings defaults and link rules, loaded first), `js/preload.js` and `js/resource-warmer.js` run in Safari too. The root Firefox manifest and runtime behavior remain the source of truth. The Safari build uses one extra permission, `scripting`, to register its content scripts. The app is named Snappy Pageload with bundle ID `io.github.pavankjadda.SnappyPageload`.

Release Safari assets are for development and testing only. They are not Apple Developer ID-signed or notarized trusted production installers. Production signing and notarization are not implemented. Safari CI does not use a personal Mac certificate or require Apple credentials to produce unsigned assets.

## Build locally

Requirements: macOS, Node.js 24 or newer, pnpm, and full Xcode for app builds. The app's deployment target comes from the installed Xcode. It was built and tested with Safari 27.2; other versions have not been tested.

For a local app signed with your personal Apple Development certificate, set your team ID:

```sh
SAFARI_DEVELOPMENT_TEAM=YOUR_TEAM_ID pnpm build:safari:app
```

For the universal Release app used for development/testing archives:

```sh
SAFARI_SIGNING_MODE=adhoc SAFARI_BUILD_NUMBER=1 pnpm build:safari:app
```

To stage and archive the Safari web extension resources:

```sh
pnpm package:safari
```

The generated extension folder is `build/safari-extension`; its archive has the manifest at its root. The app wrapper is generated under `build/safari/project` and build products under `build/safari/DerivedData`. Edit source files in the repository, not generated files.

## Install release assets

### Safari 26 or later: temporary web extension

Download `snappy_pageload-<version>-safari-web-extension.zip` and extract it to a temporary folder. In Safari, open **Settings → Developer → Add Temporary Extension**, then select the extracted extension folder. Enable **Allow unsigned extensions** if Safari requests it. Safari removes this temporary extension after 24 hours or when Safari quits.

### Unsigned development app

Download `Snappy-Pageload-<version>-macOS-unsigned-dev.app.zip`, extract it, and copy `Snappy Pageload.app` into your personal Applications folder. Launch it and enable Snappy Pageload in **Safari → Settings → Extensions**. Enable Safari's developer features and **Allow unsigned extensions**; this setting must be enabled again after each Safari restart. A downloaded unsigned app may be blocked by Gatekeeper. These assets are not trusted, signed production installers. See Apple's documentation for [running](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension) and [distributing](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension) Safari web extensions.

If macOS blocks an unidentified developer, verify that the app came from this repository's release. Only if you trust that development build, use **System Settings → Privacy & Security → Open Anyway** after attempting to launch it, as described in [Apple's instructions](https://support.apple.com/en-us/102445). This approves the individual app rather than disabling Gatekeeper globally. If unavailable, build locally with your Apple Development certificate instead. If Safari's Developer tab is hidden, enable **Settings → Advanced → Show features for web developers** first.

In Safari, open the extension's settings from **Safari → Settings → Extensions** or the toolbar. Grant website access where you want the extension to run. Open developer tools through **Develop → Show Web Inspector**.

The settings page configures preloading. **Preload visible links** and **Include page assets** are on by default; only an explicitly saved "off" disables them. Same-origin links that scroll into view (including links added later) are prepared, up to 30 per page you open (per page load, not per tab). Query-string links, `rel="ugc"`/`nofollow` links, links in comment sections and unsafe-looking links are skipped. Page assets are discovered from inert destination HTML and CSS without running destination scripts; resources requested later by scripts may be missed. Warming is limited to 20 assets per destination, 100 per page you open, 4 assets warmed at a time (Firefox does not use this limit), HTML up to 2 MiB and CSS up to 512 KiB.

Safari does not support `<link rel="prefetch">`, so hover, touch and click preloading does nothing in Safari. Without **Include page assets**, visible links also do nothing: in a local test, Safari never reused destination HTML fetched on its own. With it on, assets are warmed with `<link rel="preload">`, the only kind Safari reuses. Neither Safari nor desktop Firefox reports a data-saver setting to extensions, so there is no data-saver skip. The Firefox-only setting "Use Firefox's built-in prefetching" (privacy API) is not available in Safari and is hidden there.

Click the toolbar rocket to open settings; **Enable Snappy Pageload** there turns all features off. The blacklist is also checked inside the content scripts, because Safari may ignore `excludeMatches`. Changes apply to subsequently loaded pages; reload existing tabs. Settings use local storage on this Mac and do not sync.

Requests are same-origin fetches with same-origin credentials and normal cache semantics. Cross-origin destination redirects are rejected. Destination HTML is parsed inertly. HTTP cache reuse for a later navigation depends on Safari, response headers, and the website. An early download does not guarantee reuse or a measurable speedup. Safari reused preloaded assets that were sent with `Cache-Control: no-store` (scripts, an image and a font), so such resources can be up to one page view stale.

To inspect behavior, use Safari Web Inspector's Network panel on a cacheable same-origin page. Scroll until an eligible link enters view, then check for the early destination and asset requests. Navigate to the destination and inspect whether Safari reuses the response; compare with a `Cache-Control: no-store` response. Unit tests check request selection and API behavior; they do not establish Safari navigation speed.

For a controlled local check, run `node scripts/check-safari-cache.mjs` and open the printed loopback URL in Safari. It provides fresh cacheable and no-store links plus server request counts. Stop it with Ctrl+C when done.

## What was measured and what was not

The local check above was a single run on loopback, with no baseline without the extension and no timing. In it, Safari re-requested the destination HTML on navigation (no HTML reuse), and the five asset URLs on that fixture were not requested again. It does not show that navigation is faster.

Not verified in Safari: the on/off switch, the blacklist, background restarts, lazy images, and settings persistence.
