import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

// Archive generated evidence, not product sources. Existing archives are never
// overwritten. Every file attachment is redirected to the copied result tree.
const root = resolve(import.meta.dirname, "../..");
const name = process.argv[2];
if (!name || name !== basename(name) || !/^[a-z0-9][a-z0-9-]+$/.test(name))
  throw new Error("Provide a new lower-case archive name");
const source = resolve(root, "output/playwright/voice");
const sourceResults = resolve(source, "results");
const destination = resolve(root, "output/playwright/voice-history", name);
if (existsSync(destination))
  throw new Error("Archive already exists; choose a new name");
const report = JSON.parse(readFileSync(resolve(source, "report.json"), "utf8"));
mkdirSync(destination, { recursive: true });
const destinationResults = resolve(destination, "results");
cpSync(sourceResults, destinationResults, {
  recursive: true,
  errorOnExist: true,
  force: false,
});
const attachments = [];

function mapPath(path) {
  const absolute = resolve(root, path);
  if (absolute === sourceResults) return destinationResults;
  if (absolute.startsWith(`${sourceResults}${sep}`))
    return resolve(destinationResults, relative(sourceResults, absolute));
  return path;
}

function visit(value) {
  if (Array.isArray(value)) return value.map(visit);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "outputDir" || key === "path") && typeof item === "string")
      result[key] = mapPath(item);
    else result[key] = visit(item);
  }
  if (
    typeof result.path === "string" &&
    typeof result.contentType === "string"
  ) {
    const path = resolve(root, result.path);
    if (!path.startsWith(`${destinationResults}${sep}`) || !existsSync(path))
      throw new Error(
        `Attachment was not copied into this archive: ${result.name ?? "unnamed"}`,
      );
    attachments.push({
      name: result.name,
      contentType: result.contentType,
      path: relative(destination, path),
    });
  }
  return result;
}

const mapped = visit(report);
writeFileSync(
  resolve(destination, "report.json"),
  `${JSON.stringify(mapped, null, 2)}\n`,
);
writeFileSync(
  resolve(destination, "index.json"),
  `${JSON.stringify({ archivedAt: new Date().toISOString(), attachmentCount: attachments.length, attachments }, null, 2)}\n`,
);
process.stdout.write(
  `Archived ${attachments.length} verified file attachments: ${destination}\n`,
);
