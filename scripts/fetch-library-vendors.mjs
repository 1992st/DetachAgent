import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const vendorRoot = path.join(repoRoot, "apps", "web", "public", "vendor");
const tmpRoot = path.join(repoRoot, "storage", "cache", "library-vendors");

const vendors = [
  {
    name: "pdfjs",
    version: "4.10.38",
    url: process.env.PDFJS_VENDOR_URL || "https://github.com/mozilla/pdf.js/releases/download/v4.10.38/pdfjs-4.10.38-dist.zip",
    destination: path.join(vendorRoot, "pdfjs")
  },
  {
    name: "drawio",
    version: "28.0.4",
    url: process.env.DRAWIO_VENDOR_URL || "https://github.com/jgraph/drawio/releases/download/v28.0.4/draw.war",
    archiveName: "draw.war",
    destination: path.join(vendorRoot, "drawio")
  }
];

async function main() {
  await fs.mkdir(tmpRoot, { recursive: true });
  const manifest = [];
  for (const vendor of vendors) {
    const archive = path.join(tmpRoot, vendor.archiveName || `${vendor.name}-${vendor.version}.zip`);
    await download(vendor.url, archive);
    await fs.rm(vendor.destination, { recursive: true, force: true });
    await fs.mkdir(vendor.destination, { recursive: true });
    await unzip(archive, vendor.destination);
    await cleanVendor(vendor);
    manifest.push({
      name: vendor.name,
      version: vendor.version,
      url: vendor.url,
      sha256: await sha256(archive)
    });
  }
  await fs.writeFile(path.join(vendorRoot, "manifest.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), vendors: manifest }, null, 2)}\n`);
}

async function cleanVendor(vendor) {
  if (vendor.name === "drawio") {
    await fs.rm(path.join(vendor.destination, "WEB-INF"), { recursive: true, force: true });
    await fs.rm(path.join(vendor.destination, "META-INF"), { recursive: true, force: true });
  }
}

async function download(url, destination) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  await pipeline(response.body, createWriteStream(destination));
}

function unzip(archive, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-q", archive, "-d", destination], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`unzip exited with code ${code}`)));
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
