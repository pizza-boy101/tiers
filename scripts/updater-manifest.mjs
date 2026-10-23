// Writes latest.json, the file installed apps check for updates.
// Usage: node scripts/updater-manifest.mjs <version> <dir with release files> <owner/repo> [notes]
import fs from "node:fs";
import path from "node:path";

const [version, dir, repo, notes = ""] = process.argv.slice(2);
const files = fs.readdirSync(dir);
const url = (name) => `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(name)}`;

function entry(match) {
  const name = files.find((f) => match.test(f) && !f.endsWith(".sig"));
  if (!name) throw new Error(`No file in ${dir} matches ${match}`);
  const signature = fs.readFileSync(path.join(dir, `${name}.sig`), "utf8").trim();
  return { signature, url: url(name) };
}

const mac = entry(/\.app\.tar\.gz$/); // universal: serves both Apple Silicon and Intel
const windows = entry(/-setup\.exe$/);

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": mac,
    "darwin-x86_64": mac,
    "windows-x86_64": windows,
  },
};
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${path.join(dir, "latest.json")} for ${version}`);
