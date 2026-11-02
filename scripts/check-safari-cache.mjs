import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// A loopback-only manual fixture: server counts distinguish early downloads
// from responses actually reused when Safari navigates to a page.
const id = randomUUID();
const requests = [];
const cachedPath = `/cached/${id}`;
const freshPath = `/fresh/${id}`;
const hiddenPath = `/hidden/${id}`;
const font = readFileSync("/System/Library/Fonts/Supplemental/Arial.ttf");
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aqusAAAAASUVORK5CYII=", "base64");
function record(path, request) {
  requests.push({ path, destination: request.headers["sec-fetch-dest"], time: new Date().toISOString() });
  console.log(JSON.stringify(requests.at(-1)));
}
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  response.setHeader("Cache-Control", "no-store");
  if (path === "/stats") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(requests, null, 2));
    return;
  }
  if (path.startsWith(`/assets/${id}/`)) {
    record(path, request);
    const cached = path.includes("/cached/");
    response.setHeader("Cache-Control", cached ? "private, max-age=600" : "no-store");
    if (path.endsWith("site.css")) {
      response.setHeader("Content-Type", "text/css");
      response.end('@import "nested.css"; @font-face {font-family:CacheCheck;src:url("font.ttf")} body{font-family:CacheCheck;background-image:url("pixel.png")}');
    } else if (path.endsWith("nested.css")) {
      response.setHeader("Content-Type", "text/css"); response.end("h1{color:steelblue}");
    } else if (path.endsWith("app.js")) {
      response.setHeader("Content-Type", "text/javascript"); response.end('document.getElementById("execution").textContent="Destination JavaScript ran after navigation.";');
    } else if (path.endsWith("font.ttf")) {
      response.setHeader("Content-Type", "font/ttf"); response.end(font);
    } else if (path.endsWith("pixel.png")) {
      response.setHeader("Content-Type", "image/png"); response.end(image);
    } else { response.writeHead(404); response.end(); }
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (path === hiddenPath) {
    record(path, request);
    response.end("<!doctype html><title>Offscreen control</title><h1>Offscreen control</h1>");
    return;
  }
  if (path === cachedPath || path === freshPath) {
    record(path, request);
    if (path === cachedPath) response.setHeader("Cache-Control", "private, max-age=600");
    const assets = `/assets/${id}/${path === cachedPath ? "cached" : "fresh"}`;
    response.end(`<!doctype html><title>Safari cache check destination</title>
      <link rel="stylesheet" href="${assets}/site.css">
      <script src="${assets}/app.js" defer></script>
      <h1>${path === cachedPath ? "Cacheable" : "No-store"} destination</h1>
      <p id="execution">Destination JavaScript has not executed.</p>
      <img src="${assets}/pixel.png" alt="Test image" width="30" height="30">
      <p>Check the server request count to determine whether navigation reused the early response.</p>
      <a href="/stats" data-no-instant>View server requests</a>`);
    return;
  }
  if (path !== "/") { response.writeHead(404); response.end(); return; }
  response.end(`<!doctype html><title>Snappy Pageload Safari cache check</title>
    <h1>Snappy Pageload Safari cache check</h1>
    <p>Allow this extension on 127.0.0.1, then wait for visible links and their declared assets to preload before clicking.</p>
    <p><a href="${cachedPath}">Cacheable destination</a></p>
    <p><a href="${freshPath}">No-store destination (negative control)</a></p>
    <div style="height:200vh"></div><p><a href="${hiddenPath}">Offscreen control (must not preload before scrolling)</a></p>
    <p><a href="/stats" data-no-instant>View server requests</a></p>
    <p>One empty-destination request and no additional document request indicates cache reuse.
    A second document request indicates navigation fetched the response again. Restart this server for a fresh pair of URLs.</p>`);
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Open in Safari: http://127.0.0.1:${server.address().port}/`);
});
