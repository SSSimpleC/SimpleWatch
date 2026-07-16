import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const accounts = [
  { username: "Host", role: "host" },
  { username: "Simple", role: "viewer" },
  { username: "FJ233", role: "viewer" },
  { username: "Conflict", role: "viewer" },
  { username: "Fpliy", role: "viewer" },
  { username: "Lorrence", role: "viewer" },
].map((account) => ({
  ...account,
  password: randomBytes(24).toString("base64url"),
}));

const directory = resolve("artifacts/private");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = resolve(
  process.argv[2] ?? `${directory}/account-credentials-${stamp}.json`,
);
writeFileSync(output, `${JSON.stringify(accounts, null, 2)}\n`, {
  mode: 0o600,
  flag: "wx",
});
chmodSync(output, 0o600);
process.stdout.write(`${output}\n`);
