"""Read-only, fail-closed maintenance gate; emit counts/hashes, never secrets."""

import errno
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time


def run(*args):
    return subprocess.check_output(args, text=True, timeout=30)


services = ["app", "worker", "caddy", "tusd", "mediamtx", "livekit"]
names = [f"simplewatch-server-{service}-1" for service in services]
containers = json.loads(run("docker", "inspect", *names))
container_state = {}
for service, item in zip(services, containers):
    configuration = {key: item[key] for key in ["Config", "HostConfig", "Mounts"]}
    container_state[service] = {
        "id": item["Id"],
        "image": item["Image"],
        "running": item["State"]["Running"],
        "health": item["State"].get("Health", {}).get("Status"),
        "configurationSha256": hashlib.sha256(
            json.dumps(configuration, sort_keys=True).encode()
        ).hexdigest(),
    }

db = sqlite3.connect("file:/srv/simplewatch/state/simplewatch.sqlite3?mode=ro", uri=True)
db.execute("PRAGMA query_only=ON")
now_ms = int(time.time() * 1000)
queries = {
    "activeRooms": "SELECT COUNT(*) FROM rooms WHERE status='active'",
    "activeUploads": "SELECT COUNT(*) FROM uploads WHERE state NOT IN ('published','incompatible','failed','cancelled')",
    "reservedUploadBytes": "SELECT COALESCE(SUM(reserved_bytes),0) FROM uploads",
    "mediaJobs": "SELECT COUNT(*) FROM media_jobs WHERE state NOT IN ('completed','failed')",
    "outboxJobs": "SELECT COUNT(*) FROM service_outbox WHERE state NOT IN ('completed','failed')",
    "agentTasks": "SELECT COUNT(*) FROM edge_agent_tasks WHERE state IN ('queued','leased')",
    "transferJobs": "SELECT COUNT(*) FROM edge_transfer_jobs WHERE state IN ('queued','leased','validating','uploading','received','processing','blocked_storage','cancel_requested')",
    "evictionJobs": "SELECT COUNT(*) FROM edge_eviction_jobs WHERE state IN ('queued','verifying_source','evicting')",
}
counts = {name: db.execute(query).fetchone()[0] for name, query in queries.items()}
heartbeats = [
    {"status": status, "hasJob": job is not None, "ageMs": now_ms - seen}
    for status, job, seen in db.execute(
        "SELECT status,current_job_id,last_seen_at FROM worker_heartbeats"
    )
]
migrations = dict(db.execute("SELECT version,checksum FROM schema_migrations ORDER BY version"))
inventory = {
    "accounts": db.execute("SELECT COUNT(*) FROM accounts").fetchone()[0],
    "media": db.execute("SELECT COUNT(*) FROM media").fetchone()[0],
}
db.close()

# Read only session counts from existing private APIs. Keys remain in their
# configured container environment and are never returned to the caller.
session_script = """
import { RoomServiceClient } from 'livekit-server-sdk';
const paths = await fetch('http://mediamtx:9997/v3/paths/list').then(r => {
  if (!r.ok) throw Error('paths unavailable'); return r.json();
});
const sessions = await fetch('http://mediamtx:9997/v3/webrtcsessions/list').then(r => {
  if (!r.ok) throw Error('sessions unavailable'); return r.json();
});
const voice = await new RoomServiceClient('http://livekit:7880',
  process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET).listRooms();
console.log(JSON.stringify({paths: paths.itemCount ?? paths.items.length,
  webrtcSessions: sessions.itemCount ?? sessions.items.length, voiceRooms: voice.length}));
"""
counts.update(json.loads(run("docker", "exec", names[0], "node", "--input-type=module", "-e", session_script)))

prefixes = (
    "/srv/simplewatch/media/", "/srv/simplewatch/uploads/",
    "/srv/simplewatch/inbox/", "/srv/simplewatch/subtitles/",
    "/srv/simplewatch/sftp/incoming/", "/media/", "/uploads/",
    "/inbox/", "/subtitles/", "/sftp-incoming/",
)
counts["sftpProcesses"] = 0
counts["writableMediaDescriptors"] = 0
counts["processInspectionErrors"] = 0
for process in Path("/proc").iterdir():
    if not process.name.isdecimal():
        continue
    try:
        command = (process / "cmdline").read_bytes()
        if b"sftp-server" in command or b"sshd: sftp" in command:
            counts["sftpProcesses"] += 1
        for descriptor in (process / "fd").iterdir():
            try:
                target = os.readlink(descriptor)
                if not target.startswith(prefixes):
                    continue
                info = (process / "fdinfo" / descriptor.name).read_text()
                flags = next(line.split()[1] for line in info.splitlines() if line.startswith("flags:"))
                if int(flags, 8) & 3:
                    counts["writableMediaDescriptors"] += 1
            except OSError as error:
                if error.errno not in [errno.ENOENT, errno.ESRCH]:
                    counts["processInspectionErrors"] += 1
    except OSError as error:
        if error.errno not in [errno.ENOENT, errno.ESRCH]:
            counts["processInspectionErrors"] += 1

quiet = (
    all(value == 0 for value in counts.values())
    and len(heartbeats) == 1
    and all(h["status"] == "idle" and not h["hasJob"] and 0 <= h["ageMs"] < 60_000 for h in heartbeats)
    and all(c["running"] and c["health"] in [None, "healthy"] for c in container_state.values())
)
print(json.dumps({
    "atMs": now_ms, "quiet": quiet,
    "current": str(Path("/opt/simplewatch/current").resolve()),
    "counts": counts, "heartbeats": heartbeats, "inventory": inventory,
    "migrations": migrations, "containers": container_state,
}, indent=2))
raise SystemExit(0 if quiet or "--snapshot" in sys.argv[1:] else 2)
