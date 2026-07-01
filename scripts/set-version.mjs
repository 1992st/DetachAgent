import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const version = process.argv[2];

if (!version) {
  console.error("Usage: pnpm version:set <semver>");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version: ${version}`);
  console.error("Expected semver like 0.1.1 or 0.1.1-beta.1");
  process.exit(1);
}

const packageFiles = [
  path.join(repoRoot, "package.json"),
  path.join(repoRoot, "apps", "desktop", "package.json"),
  path.join(repoRoot, "apps", "server", "package.json"),
  path.join(repoRoot, "apps", "web", "package.json"),
  path.join(repoRoot, "packages", "shared", "package.json"),
  path.join(repoRoot, "packages", "openclaw-detaches-adapter", "package.json"),
  path.join(repoRoot, "cli", "package.json")
];

for (const file of packageFiles) {
  const content = await fs.readFile(file, "utf8");
  const json = JSON.parse(content);
  json.version = version;
  await fs.writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`updated ${path.relative(repoRoot, file)} -> ${version}`);
}
