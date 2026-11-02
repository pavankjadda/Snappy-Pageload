import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { version } = await import("./build-safari.mjs");
const root = new URL("../", import.meta.url);
const artifacts = new URL("web-ext-artifacts/", root);
await mkdir(artifacts, { recursive: true });
const archive = new URL(`snappy_pageload-${version}-safari-web-extension.zip`, artifacts);
// zip updates existing archives; remove this generated file so deleted files cannot survive.
await rm(archive, { force: true });
execFileSync("zip", ["-q", "-r", fileURLToPath(archive), ".", "-x", "*.DS_Store"], {
  cwd: fileURLToPath(new URL("build/safari-extension/", root)), stdio: "inherit",
});
execFileSync("unzip", ["-tq", fileURLToPath(archive)], { stdio: "inherit" });
const entries = execFileSync("unzip", ["-Z1", fileURLToPath(archive)], { encoding: "utf8" }).split("\n");
if (!entries.includes("manifest.json")) throw new Error("Safari archive must contain manifest.json at its root.");
console.log(`Safari Web Extension archive: ${fileURLToPath(archive)}`);
