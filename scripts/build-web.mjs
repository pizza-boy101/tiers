// Builds the web / home-screen version into dist-web/.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const out = "dist-web";
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

for (const file of ["app.js", "styles.css", "icon.svg"]) {
  await fs.copyFile(path.join("public", file), path.join(out, file));
}
await fs.cp("web/icons", path.join(out, "icons"), { recursive: true });
await fs.copyFile("web/manifest.webmanifest", path.join(out, "manifest.webmanifest"));
await fs.copyFile("web/connect.html", path.join(out, "connect.html"));

for (const [entry, file] of [["src/backend-web.js", "backend.js"], ["src/connect.js", "connect.js"]]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    target: ["safari15", "chrome100"],
    outfile: path.join(out, file),
  });
}

const head = `
  <meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#161615" media="(prefers-color-scheme: dark)">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Tiers">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="icons/icon-180.png">
`;
let html = await fs.readFile("public/index.html", "utf8");
html = html
  .replace('content="width=device-width, initial-scale=1"', 'content="width=device-width, initial-scale=1, viewport-fit=cover"')
  .replace("</head>", `${head}</head>`);
await fs.writeFile(path.join(out, "index.html"), html);

// Offline cache list, versioned by the content of every file.
const files = [];
const hash = createHash("sha256");
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else {
      files.push(path.relative(out, full).split(path.sep).join("/"));
      hash.update(await fs.readFile(full));
    }
  }
}
await walk(out);
const list = ["./", ...files.filter((f) => !["index.html", "connect.html", "connect.js"].includes(f)), "index.html"];
const sw = (await fs.readFile("web/sw.js", "utf8"))
  .replace("__VERSION__", `tiers-${hash.digest("hex").slice(0, 12)}`)
  .replace("__FILES__", JSON.stringify(list));
await fs.writeFile(path.join(out, "sw.js"), sw);

console.log(`Built ${out}/ (${files.length + 1} files)`);
