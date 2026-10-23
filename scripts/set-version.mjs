// Sets the app version everywhere it's recorded. Usage: node scripts/set-version.mjs 1.2.3
import fs from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("Usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(1);
}
for (const file of ["package.json", "src-tauri/tauri.conf.json"]) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
const cargo = "src-tauri/Cargo.toml";
fs.writeFileSync(cargo, fs.readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`));
console.log(`Version set to ${version}`);
