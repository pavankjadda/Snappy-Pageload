import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("build/safari-extension/", root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Explicit runtime allowlist: never copy local signing secrets or tooling.
for (const file of ["js", "icons", "static", "options.html", "options.css"]) {
  await cp(new URL(file, root), new URL(file, output), { recursive: true });
}
await cp(new URL("safari/content-scripts-adapter.js", root), new URL("js/safari-content-scripts-adapter.js", output));
await cp(new URL("safari/setup.html", root), new URL("static/setup.html", output));
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
export const { version } = manifest;
delete manifest.browser_specific_settings;
delete manifest.developer;
manifest.description = "Preload visible same-site pages and their declared assets. Local Safari build with experimental HTTP cache warming.";
manifest.background = {
  scripts: ["js/safari-content-scripts-adapter.js", ...manifest.background.scripts],
  persistent: false,
};
// Safari has no browser.privacy.
manifest.permissions = [...manifest.permissions.filter((permission) => permission !== "privacy"), "scripting"];
await writeFile(new URL("manifest.json", output), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Safari extension staged at ${fileURLToPath(output)}`);
