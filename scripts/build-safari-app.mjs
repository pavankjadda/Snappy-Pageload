import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const signingMode = process.env.SAFARI_SIGNING_MODE || "development";
if (!["development", "adhoc"].includes(signingMode)) throw new Error("SAFARI_SIGNING_MODE must be development or adhoc.");
const team = process.env.SAFARI_DEVELOPMENT_TEAM;
if (signingMode === "development" && !team) {
  throw new Error("Set SAFARI_DEVELOPMENT_TEAM to your Apple Development certificate's Team ID.");
}
const packager = ["safari-web-extension-packager", "safari-web-extension-converter"].find(
  (tool) => spawnSync("xcrun", ["--find", tool], { stdio: "ignore" }).status === 0,
);
if (!packager) throw new Error("Safari's web extension packager requires a full Xcode installation.");
await import("./build-safari.mjs");

const root = fileURLToPath(new URL("../", import.meta.url));
const appName = "Snappy Pageload";
const { version } = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const bundleID = process.env.SAFARI_BUNDLE_ID || "io.github.pavankjadda.SnappyPageload";
const project = `build/safari/project/${appName}/${appName}.xcodeproj`;
const versionFile = new URL("../build/safari/build-number", import.meta.url);
await mkdir(new URL("../build/safari/", import.meta.url), { recursive: true });
let buildNumber = process.env.SAFARI_BUILD_NUMBER;
if (buildNumber !== undefined && !/^[1-9]\d*$/.test(buildNumber)) throw new Error("SAFARI_BUILD_NUMBER must be a positive integer.");
if (buildNumber === undefined) {
  let previous = 0;
  try {
    previous = Number(await readFile(versionFile, "utf8")) || 0;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  buildNumber = String(previous + 1);
}
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
run("xcrun", [
  packager, "--macos-only", "--swift", "--no-open", "--no-prompt",
  "--app-name", appName, "--bundle-identifier", bundleID,
  "--project-location", "build/safari/project", "--copy-resources", "--force",
  "build/safari-extension",
]);

// Xcode 27's packager derives the app ID from the spaced name, while retaining
// the requested ID for the extension. Repair the generated parent ID only.
for (const name of ["project.xcproj", "project.pbxproj"]) {
  const file = new URL(`../${project}/${name}`, import.meta.url);
  try {
    await access(file);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const contents = await readFile(file, "utf8");
  await writeFile(file, contents.replaceAll("io.github.pavankjadda.Snappy-Pageload", bundleID));
}
const configuration = signingMode === "adhoc" ? "Release" : "Debug";
const signingSettings = signingMode === "adhoc"
  ? ["DEVELOPMENT_TEAM=", "CODE_SIGN_IDENTITY=-", "ARCHS=arm64 x86_64", "ONLY_ACTIVE_ARCH=NO"]
  : [`DEVELOPMENT_TEAM=${team}`, "CODE_SIGN_IDENTITY=Apple Development"];
run("xcodebuild", [
  "-project", project, "-scheme", appName, "-configuration", configuration,
  "-destination", "platform=macOS", "-derivedDataPath", "build/safari/DerivedData",
  ...signingSettings, `CURRENT_PROJECT_VERSION=${buildNumber}`, `MARKETING_VERSION=${version}`,
  "MACOSX_DEPLOYMENT_TARGET=13.0", "CODE_SIGN_STYLE=Manual", "CODE_SIGNING_ALLOWED=YES", "build",
]);
// Persist only after a successful build, so failed builds don't burn build numbers.
if (process.env.SAFARI_BUILD_NUMBER === undefined) await writeFile(versionFile, buildNumber);
console.log(`Built (${signingMode}): ${root}build/safari/DerivedData/Build/Products/${configuration}/${appName}.app`);
