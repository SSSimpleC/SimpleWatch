"""One-release App/Worker maintenance. No account/media/schema/infrastructure edits.

Invoke on the cloud host with the prepared release directory. The original full
stack Compose and environment remain untouched. Container labels plus the
receipt record the additional image-only override needed by future maintenance.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

BASELINE = Path("/opt/simplewatch/releases/20260801-120900-crossmount-86930ec")
PREVIOUS_PAIR = Path("/opt/simplewatch/releases/20261022-player-da98dd2cc28c/ops/compose.player.json")
OLD_IMAGE = "sha256:e8f1471d98cb61902596c9d3027bbe7fb76ae537003e1b8a68b6b0b0b1981941"
release = Path(sys.argv[1]).resolve()
if release.parent != Path("/opt/simplewatch/releases") or not re.fullmatch(r"20261023-player-[0-9a-f]{12}", release.name):
    raise RuntimeError("Unexpected release target")
source = release / "source"
ops = release / "ops"
if (ops / "deployed.json").exists():
    raise RuntimeError("Release already deployed; inspect its receipt before retrying")
if Path("/opt/simplewatch/current").resolve() != BASELINE:
    raise RuntimeError("Full-stack baseline changed")
if json.loads(PREVIOUS_PAIR.read_text()) != {"services": {"app": {"image": OLD_IMAGE}, "worker": {"image": OLD_IMAGE}}}:
    raise RuntimeError("Previous pair override changed")
os.umask(0o077)


def run(*args, timeout=60):
    return subprocess.check_output(args, text=True, timeout=timeout)


def save(name, data):
    (ops / name).write_text(json.dumps(data, indent=2) + "\n")


def preflight(snapshot=False):
    args = ["--snapshot"] if snapshot else []
    return json.loads(run("python3", str(ops / "player-preflight.py"), *args))


def inventory():
    db = sqlite3.connect("file:/srv/simplewatch/state/simplewatch.sqlite3?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    result = {}
    for table in ["accounts", "media", "subtitles", "schema_migrations"]:
        rows = db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
        result[table] = {"rows": len(rows), "sha256": hashlib.sha256(json.dumps(rows).encode()).hexdigest()}
    db.close()
    return result


manifest = json.loads((source / "source-manifest.json").read_text())
if manifest.get("dirty") is not False or manifest.get("releaseKind") != "production":
    raise RuntimeError("Production deployment requires a clean, committed Git release manifest")
if not re.fullmatch(r"[0-9a-f]{40}", manifest.get("gitSha", "")):
    raise RuntimeError("Production Git SHA is missing")
if manifest["releaseTag"] != release.name:
    raise RuntimeError("Manifest tag mismatch")
for entry in manifest["entries"]:
    path = source / entry["file"]
    if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(source):
        raise RuntimeError("Invalid manifest file")
    if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
        raise RuntimeError("Source hash mismatch")

before = preflight()
if before["containers"]["app"]["image"] != OLD_IMAGE or before["containers"]["worker"]["image"] != OLD_IMAGE:
    raise RuntimeError("Running pair is no longer the validated baseline")
expected_migrations = {
    Path(entry["file"]).stem.split("_", 1)[0]: entry["sha256"]
    for entry in manifest["entries"] if entry["file"].startswith("migrations/")
}
if expected_migrations != before["migrations"]:
    raise RuntimeError("Database migration required: deployment prohibited")

image = run("docker", "image", "inspect", f"simplewatch-app:{release.name}", "--format", "{{.Id}}").strip()
if not re.fullmatch(r"sha256:[0-9a-f]{64}", image) or image == OLD_IMAGE:
    raise RuntimeError("Invalid candidate image")
labels = json.loads(run("docker", "image", "inspect", image, "--format", "{{json .Config.Labels}}")) or {}
if (
    labels.get("org.opencontainers.image.revision") != manifest["gitSha"]
    or labels.get("simplewatch.source-sha256") != manifest["sourceSha256"]
    or labels.get("simplewatch.release-kind") != "production"
):
    raise RuntimeError("Candidate provenance does not match the production source manifest")

probe = """
import {createRequire} from 'node:module';
import {readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
if (process.platform!=='linux'||process.arch!=='x64'||process.version!=='v24.18.0') throw Error('runtime changed');
const fastify=require('fastify/package.json').version;
if(fastify!=='5.12.7') throw Error('Fastify patch missing');
const packages=readdirSync('node_modules/.pnpm');
for(const name of packages){
 if(name.startsWith('fast-uri@')&&!/^fast-uri@(3\\.1\\.8|4\\.1\\.5)$/.test(name)) throw Error('fast-uri patch missing');
 if(name.startsWith('brace-expansion@5.')&&name!=='brace-expansion@5.0.12') throw Error('brace patch missing');
}
const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('CREATE TABLE proof(v TEXT)');db.close();
await require('argon2').hash('isolated-runtime-probe',{memoryCost:4096,timeCost:1,parallelism:1});
execFileSync(process.execPath,['--check','dist/api.mjs']);
execFileSync(process.execPath,['--check','dist/worker.mjs']);
console.log(JSON.stringify({node:process.version,fastify,ffmpeg:execFileSync('ffmpeg',['-version'],{encoding:'utf8'}).split('\\n')[0]}));
"""
runtime = json.loads(run("docker", "run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=192m", "--cpus=0.5", "--pids-limit=32", image, "node", "--input-type=module", "-e", probe))
old_ffmpeg = run("docker", "exec", "simplewatch-server-app-1", "ffmpeg", "-version").splitlines()[0]
if runtime["ffmpeg"] != old_ffmpeg:
    raise RuntimeError("FFmpeg runtime changed")

compose = ["docker", "compose", "-p", "simplewatch-server", "--env-file", str(BASELINE / ".env.server"), "-f", str(BASELINE / "infra/compose/compose.server-ip.yaml"), "-f", str(PREVIOUS_PAIR)]
override = ops / "compose.player.json"
save(override.name, {"services": {"app": {"image": image}, "worker": {"image": image}}})
candidate = compose + ["-f", str(override)]
original_config = json.loads(run(*compose, "config", "--format", "json"))
candidate_config = json.loads(run(*candidate, "config", "--format", "json"))
for service in ["app", "worker"]:
    original_config["services"][service]["image"] = image
if original_config != candidate_config:
    raise RuntimeError("Compose change is not limited to the two images")
save("runtime-check.json", runtime)
print("Candidate runtime, native dependencies, migration and image-only Compose checks passed", flush=True)

# A new consistent backup; never invoke retention cleanup or restore it over
# live state during application rollback.
backup_path = ops / "predeploy.sqlite3"
if backup_path.exists():
    raise RuntimeError("A previous backup exists; inspect prior attempt first")
db = sqlite3.connect("file:/srv/simplewatch/state/simplewatch.sqlite3?mode=ro", uri=True)
backup = sqlite3.connect(backup_path)
db.backup(backup)
assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert not backup.execute("PRAGMA foreign_key_check").fetchall()
backup.close()
db.close()
before_inventory = inventory()
before = preflight()
save("before.json", before)
save("inventory-before.json", before_inventory)


def await_health():
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        states = json.loads(run("docker", "inspect", "simplewatch-server-app-1", "simplewatch-server-worker-1"))
        if all(item["State"].get("Health", {}).get("Status") == "healthy" for item in states):
            result = json.loads(run("curl", "--fail", "--silent", "--show-error", "--max-time", "10", "https://8.134.239.34/health/ready"))
            if result.get("status") == "ready":
                return result
        time.sleep(2)
    raise RuntimeError("Paired deployment did not become ready")


attempted = False
try:
    attempted = True
    subprocess.run(candidate + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app", "worker"], check=True, timeout=150)
    health = await_health()
    # A user joining after maintenance is not itself a reason to roll back.
    after = preflight(snapshot=True)
    for service in ["caddy", "tusd", "mediamtx", "livekit"]:
        if after["containers"][service] != before["containers"][service]:
            raise RuntimeError(f"Untargeted service changed: {service}")
    for service in ["app", "worker"]:
        if after["containers"][service]["image"] != image:
            raise RuntimeError("Pair image mismatch")
    after_inventory = inventory()
    if after["migrations"] != before["migrations"]:
        raise RuntimeError("Database migrations changed")
    if after["quiet"] and after_inventory != before_inventory:
        raise RuntimeError("Protected database inventory changed while idle")
    save("deployed.json", {
        "atMs": int(time.time() * 1000), "release": str(release), "image": image,
        "fullStackBaseline": str(BASELINE), "previousPairOverride": str(PREVIOUS_PAIR), "sourceSha256": manifest["sourceSha256"],
        "health": health, "after": after,
        "inventoryUnchanged": after_inventory == before_inventory,
        "maintenanceCommand": candidate,
        "rollbackCommand": compose + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app", "worker"],
    })
    print(f"DEPLOYED_APP_WORKER_ONLY {image}", flush=True)
except BaseException:
    if attempted:
        print("Validation failed; rolling back only App/Worker images, not database/media", flush=True)
        subprocess.run(compose + ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "app", "worker"], check=True, timeout=150)
        await_health()
        save("rolled-back.json", {"atMs": int(time.time() * 1000), "image": OLD_IMAGE})
    raise
