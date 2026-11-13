# Snappy Pageload

Preload links and their declared assets in **Firefox and Safari on macOS**. Pages are prepared as links enter your viewport; Firefox also prefetches on hover, touch and mouse-down.

**Chrome users:** use **Settings → Performance → Preload pages**, then choose **Standard preloading** or **Extended preloading**. [Google's instructions](https://support.google.com/chrome/answer/12929150?hl=en)

## Installation

Get builds from [GitHub Releases](https://github.com/pavankjadda/Snappy-Pageload/releases).

| Browser | Download |
|---|---|
| Firefox | `.xpi` when available, or `snappy_pageload-<version>.zip` for temporary testing |
| Safari on macOS | `Snappy-Pageload-<version>-macOS-unsigned-dev.app.zip` |
| Safari temporary extension | `snappy_pageload-<version>-safari-web-extension.zip` |

### Firefox

- **Signed `.xpi`:** open `about:addons` → gear icon → **Install Add-on From File…**.
- **Unsigned ZIP:** extract it, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select `manifest.json`. Firefox removes temporary add-ons when it restarts.

### Safari on macOS

Extract the app ZIP, copy **Snappy Pageload.app** to your Applications folder, launch it, and enable it in **Safari → Settings → Extensions**. Allow access to the websites where you want it to run.

Safari release builds are **for development/testing**, not Apple Developer ID-signed or notarized. They require **Allow unsigned extensions**, which resets after Safari restarts. See [Safari installation and local build instructions](safari/README.md) for setup and temporary-extension loading.

## Settings

Click the toolbar rocket to open settings, then click **Save settings** after making changes. Reload existing tabs to apply them.

| Setting | Default | Purpose |
|---|---|---|
| Enable Snappy Pageload | On | Turn all features on or off |
| Preload visible links | On | Prepare eligible links as they enter view |
| Include page assets | On | Warm declared scripts, stylesheets, fonts and selected images |
| Use Firefox's built-in prefetching | On | Firefox only: keep Firefox's own link prefetching, DNS prefetching and network predictor turned on (see below) |
| Lazy-load images | Off | Use native lazy loading for images on the current page |
| Blacklist sites | Empty | Disable the extension on selected sites |

**Use Firefox's built-in prefetching** uses Firefox's privacy API (`privacy.network.networkPredictionEnabled`), which controls link prefetching (`network.prefetch-next`), DNS prefetching (`network.dns.disablePrefetch`) and speculative connections (`network.http.speculative-parallel-limit`). Older Firefox versions also put the network predictor under this setting; current versions no longer have one. While it is on, Snappy Pageload turns these on even if a privacy setup such as arkenfox, LibreWolf or a hardened profile turned them off. If you want your own choice kept, turn this setting off. Turning it off, switching Snappy Pageload off or removing the add-on restores your own setting. If an enterprise policy or another extension controls the setting, Snappy Pageload cannot change it. This setting is not available in Safari (no privacy API), so it is hidden there.

Blacklist examples: `example.com` for one host, or `*.example.com` for that host and its subdomains. Separate entries with commas.

**Safari:** keep **Include page assets** enabled. Hover prefetching is unavailable, and visible-link warming does nothing without this option. Settings remain on your Mac; Firefox settings can use Firefox Sync.

## Limits and privacy

- Only same-origin destinations—matching scheme, host and port—are eligible. Visible-link preloading skips query strings, user-generated links and URLs that look like actions.
- Limits per page load: **30 destination pages**, **100 assets total**, **20 assets per destination**, and, in Safari, up to **4 assets warmed at a time**. Firefox does not apply that limit: it adds low-priority `<link rel=prefetch>` hints and Firefox's own prefetch queue fetches them (by default up to 6 in parallel, starting after the current page has finished loading; see [Firefox `about:config` tuning](#firefox-aboutconfig-tuning) to change that).
- Destination scripts are not executed. Resources loaded only by JavaScript may be missed; the extension does not download every asset indiscriminately.
- Cache headers and browser behavior determine reuse. Early downloads do not guarantee faster navigation; Safari may fetch the destination HTML again.
- No telemetry or collection server. Sites and referenced asset hosts can see early requests, even when you never open the destination. Use the blacklist where needed.

If preloading does not work, check the enable switch, site permissions and blacklist, then reload the page. In Firefox, `network.prefetch-next` must be enabled for native prefetching. With **Use Firefox's built-in prefetching** on, Snappy Pageload handles this automatically, unless an enterprise policy or another extension controls the setting. If it does not take effect, or you turned that setting off, open `about:config` and set `network.prefetch-next` to `true` yourself.

## Firefox `about:config` tuning

Optional. Snappy Pageload works without any of this; these preferences make Firefox itself preload more aggressively. Defaults were checked against Firefox 160, and preferences can change or disappear in later versions. To undo a change, reset the preference in `about:config`.

The **Use Firefox's built-in prefetching** setting only manages `network.prefetch-next`, `network.dns.disablePrefetch` and `network.http.speculative-parallel-limit`. Everything else below is yours to set.

### Prefetch queue

These control how Firefox fetches the `<link rel=prefetch>` hints Snappy Pageload adds.

| Preference | Default | Aggressive value | Effect |
|---|---|---|---|
| `network.prefetch-next` | `true` | `true` | Enables link prefetching. Must stay on. |
| `network.prefetch-next.parallelism` | `6` | `20` | Number of prefetches that run at the same time. |
| `network.prefetch-next.aggressive` | `false` | `true` | Starts prefetching while the current page is still loading, instead of waiting for it to finish. |
| `network.prefetch-next.force-valid-for` | `300` | `90` | Seconds a prefetched page without cache headers is reused before Firefox revalidates it. `90` favours fresh pages; raise it (for example `900`) for more cache hits at the risk of stale pages. |
| `network.http.max-persistent-connections-per-server` | `6` | `15` | HTTP/1.1 hosts only: connections allowed to one host, which otherwise caps the prefetch queue at 6. No effect on HTTP/2 or HTTP/3. |

`network.prefetch-next.parallelism` and `network.prefetch-next.aggressive` are not listed until you create them: type the name in `about:config`, choose **Number** or **Boolean**, and click **+**.

### DNS and connections

Snappy Pageload only prefetches same-origin pages, so these are what speed up links to other sites.

| Preference | Default | Aggressive value | Effect |
|---|---|---|---|
| `network.dns.disablePrefetch` | `false` | `false` | Allows speculative DNS lookups. |
| `network.dns.disablePrefetchFromHTTPS` | `false` | `false` | Allows DNS prefetching from HTTPS pages. |
| `dom.prefetch_dns_for_anchor_https_document` | `false` | `true` | Resolves DNS for every link on HTTPS pages, not only on HTTP pages. |
| `network.predictor.enable-hover-on-ssl` | `false` | `true` | Hovering a link on an HTTPS page opens a connection (DNS, TCP, TLS) to its host. By default this happens only on HTTP pages. |
| `network.dnsCacheExpiration` | `60` | `300` | Seconds a DNS answer is kept. |

### Speculation rules (experimental)

Firefox enables these by default only in Nightly. They make Firefox honour the `<script type="speculationrules">` prefetch rules that sites ship for Chrome (same-origin only). Turn `dom.speculation_rules.enabled` off first if pages misbehave.

| Preference | Default | Aggressive value | Effect |
|---|---|---|---|
| `dom.speculation_rules.enabled` | `false` | `true` | Turns speculation rules on. |
| `dom.speculation_rules.moderate_hover_delay_ms` | `200` | `50` | Hover time in milliseconds before a "moderate" rule prefetches. |
| `dom.speculation_rules.max_records_per_document` | `20` | `50` | Maximum prefetches per page from speculation rules. |

### Already at their most aggressive

Leave these at their defaults: `network.http.speculative-parallel-limit` (`20`), `network.preconnect`, `network.modulepreload`, `network.early-hints.enabled`, `browser.urlbar.speculativeConnect.enabled` and `browser.places.speculativeConnect.enabled` (all `true`).

### Trade-offs

- More requests, data and battery use.
- Your DNS resolver and the linked sites see lookups and connections for pages you never open.
- Firefox partitions its cache per site, so a prefetched cross-origin page is never reused; for links to other sites, DNS and connection warming is the most these settings can do.

## Permissions

Snappy Pageload requests access to `http://*/*` and `https://*/*` pages to find links and assets, plus `storage` for your settings. In Firefox it also asks for **privacy** (shown as "Read and modify privacy settings" when you install or update). It is used only to keep Firefox's built-in prefetching on, as described under Settings, and to restore your own value when you turn that off. Safari does not use it. Safari builds use `scripting` to register content scripts.

## Development

Requires Node.js 24+ and pnpm. Safari app builds also require macOS and full Xcode.

```sh
pnpm install
pnpm start           # Firefox development session
pnpm test
pnpm lint
pnpm package         # Validate and build the Firefox ZIP
pnpm package:safari  # Build the Safari Web Extension ZIP
```

### Project layout

- `manifest.json`: Firefox manifest (MV2).
- `js/shared.js`: settings defaults and link rules shared by the background script, settings page and content scripts. It is loaded first everywhere.
- `js/background.js`: registers the content scripts and applies settings (including the privacy setting in Firefox).
- `js/preload.js`: finds and prepares links.
- `js/resource-warmer.js`: finds and warms destination assets.
- `js/lazy_images.js`: optional image lazy loading.
- `js/options.js`: the settings page.
- `safari/`: the Safari adapter and Xcode project.

See [Safari build instructions](safari/README.md) for signed local apps and unsigned development apps.

The [release workflow](.github/workflows/release.yml) attaches Firefox and Safari archives to GitHub releases. A Mozilla-signed `.xpi` is added only when `AMO_API_KEY` and `AMO_API_SECRET` are configured. See [CHANGELOG.md](CHANGELOG.md) for release history.

## Credits

Forked from [Faster Pageload](https://github.com/simonfrey/faster-pageload-web-extensions) by Simon Frey, with a preloading approach based on [instant.page](https://instant.page/). [MIT license](LICENSE).
