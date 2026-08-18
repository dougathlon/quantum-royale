import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const ROOT = resolve("dist");
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".txt",
]);
const FORBIDDEN_TEXT = [
  "__QUANTUM_ROYALE_TEST__",
  "sourceMappingURL=",
  ["/", "Users", "/"].join(""),
  "127.0.0.1",
  "localhost",
];

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(ROOT);
const relativeFiles = files.map((path) => relative(ROOT, path));
const failures = [];

for (const required of [
  "index.html",
  "THIRD_PARTY_NOTICES.md",
  "assets/pixel/ui/shield.png",
  "social-card.png",
]) {
  if (!relativeFiles.includes(required)) failures.push(`missing ${required}`);
}

for (const file of files) {
  const relativePath = relative(ROOT, file);
  if (relativePath.endsWith(".map"))
    failures.push(`source map ${relativePath}`);
  if (relativePath.includes("legacy-svg"))
    failures.push(`legacy art ${relativePath}`);
  if (!TEXT_EXTENSIONS.has(extname(file))) continue;
  const contents = readFileSync(file, "utf8");
  for (const forbidden of FORBIDDEN_TEXT) {
    if (contents.includes(forbidden))
      failures.push(`${relativePath} contains ${forbidden}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Release artifact rejected:\n${failures.join("\n")}`);
}

console.log(
  `Release artifact accepted: ${files.length} files, no forbidden residue.`,
);
