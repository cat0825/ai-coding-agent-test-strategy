#!/usr/bin/env python3
"""Transparent Codex proxy that records output-event arrival times.

The wrapper is copied into a private run directory as ``codex``. Its sibling
configuration names the real binary and lifecycle output directory, so no
collector-specific environment variable needs to enter the agent process.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CONFIG_NAME = "codex-lifecycle-config.json"
SUPPORTED_EVENTS = {
    "thread.started",
    "turn.started",
    "item.started",
    "item.completed",
    "turn.completed",
    "turn.failed",
}
FILE_CHANGE_KINDS = {"add", "delete", "update"}

# Directories never traversed when observing shell-driven workspace writes. They
# are either version-control internals or regenerated build/runtime artifacts, so
# hashing them would cost far more than it reveals.
SNAPSHOT_EXCLUDED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    ".turbo",
    ".gradle",
    "target",
    "dist",
    "build",
    "coverage",
}
# Bounds keep the observation cheap. Exceeding either bound marks the snapshot
# truncated, which makes the verifier fail closed instead of trusting a partial view.
SNAPSHOT_MAX_FILES = 20000
SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def safe_workspace_path(value: Any, workspace_root: Path) -> tuple[str | None, str | None]:
    if not isinstance(value, str) or not value or "\x00" in value:
        return None, None
    portable = value.replace("\\", "/")
    if re.match(r"^[A-Za-z]:/", portable):
        return None, sha256_text(portable)
    candidate = Path(portable)
    if candidate.is_absolute():
        try:
            relative = candidate.resolve(strict=False).relative_to(workspace_root.resolve(strict=False))
        except ValueError:
            return None, sha256_text(portable)
        portable = relative.as_posix()
    raw_parts = portable.split("/")
    if any(part == ".." for part in raw_parts):
        return None, sha256_text(portable)
    parts = [part for part in raw_parts if part not in {"", "."}]
    if not parts:
        return None, sha256_text(portable)
    return "/".join(parts), None


def _entry_digest(entry: os.DirEntry[str]) -> tuple[str, bool]:
    """Content digest for one workspace entry. Contents never leave this function."""
    try:
        if entry.is_symlink():
            return "symlink\0" + sha256_text(os.readlink(entry.path)), True
        stat_result = entry.stat(follow_symlinks=False)
        if not entry.is_file(follow_symlinks=False):
            return "other", True
        if stat_result.st_size > SNAPSHOT_MAX_FILE_BYTES:
            return f"oversize\0{stat_result.st_size}", False
        digest = hashlib.sha256()
        with open(entry.path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return "file\0" + digest.hexdigest(), True
    except OSError:
        return "unreadable", False


def snapshot_workspace(
    workspace_root: Path,
    excluded_paths: set[Path] | None = None,
) -> tuple[dict[str, str], bool]:
    """Map workspace-relative path -> content digest.

    Returns the map and whether the walk was truncated. Only digests are kept, so
    no file contents are retained beyond the hashing above.
    """
    snapshot: dict[str, str] = {}
    truncated = False
    excluded_paths = {path.resolve(strict=False) for path in (excluded_paths or set())}
    stack = [workspace_root]
    while stack:
        directory = stack.pop()
        if directory.resolve(strict=False) in excluded_paths:
            continue
        try:
            entries = list(os.scandir(directory))
        except OSError:
            truncated = True
            continue
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                if entry.name in SNAPSHOT_EXCLUDED_DIRS:
                    continue
                stack.append(Path(entry.path))
                continue
            if len(snapshot) >= SNAPSHOT_MAX_FILES:
                truncated = True
                continue
            try:
                relative = Path(entry.path).relative_to(workspace_root).as_posix()
            except ValueError:
                truncated = True
                continue
            digest, entry_complete = _entry_digest(entry)
            snapshot[relative] = digest
            if not entry_complete:
                truncated = True
    return snapshot, truncated


def diff_snapshots(before: dict[str, str], after: dict[str, str]) -> list[dict[str, str]]:
    """Classify the delta between two snapshots as add/update/delete."""
    changes: list[dict[str, str]] = []
    for path_value in sorted(set(before) | set(after)):
        previous = before.get(path_value)
        current = after.get(path_value)
        if previous == current:
            continue
        if previous is None:
            kind = "add"
        elif current is None:
            kind = "delete"
        else:
            kind = "update"
        changes.append({"path": path_value, "kind": kind})
    return changes


def load_config() -> dict[str, Any]:
    config_path = Path(__file__).resolve().with_name(CONFIG_NAME)
    with config_path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    if config.get("schema_version") != 1:
        raise RuntimeError("unsupported collector configuration")
    for key in ("real_codex", "lifecycle_dir", "collector_sha256"):
        if not isinstance(config.get(key), str) or not config[key]:
            raise RuntimeError(f"collector configuration requires {key}")
    return config


class LifecycleWriter:
    def __init__(self, directory: Path, collector_sha256: str, cwd_sha256: str) -> None:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        filename = f"codex-{time.time_ns()}-{os.getpid()}-{secrets.token_hex(4)}.ndjson"
        path = directory / filename
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self._handle = os.fdopen(descriptor, "w", encoding="utf-8", buffering=1)
        self._started_ns = time.monotonic_ns()
        self._sequence = 0
        self.write(
            "collector.started",
            collector_sha256=collector_sha256,
            collector_version="2",
            cwd_sha256=cwd_sha256,
        )

    def write(self, event: str, **fields: Any) -> None:
        record = {
            "schema_version": 1,
            "sequence": self._sequence,
            "event": event,
            "observed_at": utc_now(),
            "monotonic_ns": time.monotonic_ns() - self._started_ns,
            **fields,
        }
        self._handle.write(json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n")
        self._sequence += 1

    def close(self) -> None:
        self._handle.close()


def lifecycle_fields(event: dict[str, Any], workspace_root: Path) -> tuple[str, dict[str, Any]] | None:
    event_type = event.get("type")
    if event_type not in SUPPORTED_EVENTS:
        return None
    if event_type == "thread.started":
        thread_id = event.get("thread_id")
        return event_type, {"thread_id": thread_id} if isinstance(thread_id, str) else {}
    if event_type in {"item.started", "item.completed"}:
        item = event.get("item")
        if not isinstance(item, dict):
            return None
        if item.get("type") == "file_change":
            if event_type != "item.completed":
                return None
            changes = item.get("changes")
            sanitized_changes: list[dict[str, Any]] = []
            if isinstance(changes, list):
                for change in changes:
                    if not isinstance(change, dict):
                        sanitized_changes.append({"path": None, "path_sha256": None, "kind": None})
                        continue
                    safe_path, path_sha256 = safe_workspace_path(change.get("path"), workspace_root)
                    kind = change.get("kind")
                    sanitized_changes.append({
                        "path": safe_path,
                        "path_sha256": path_sha256,
                        "kind": kind if kind in FILE_CHANGE_KINDS else None,
                    })
            status = item.get("status")
            return "file_change.completed", {
                "call_id": str(item.get("id", "")),
                "status": status if isinstance(status, str) else None,
                "changes": sanitized_changes,
            }
        if item.get("type") != "command_execution":
            return None
        fields: dict[str, Any] = {
            "call_id": str(item.get("id", "")),
            "item_type": "command_execution",
        }
        if event_type == "item.completed":
            exit_code = item.get("exit_code")
            fields["exit_code"] = exit_code if isinstance(exit_code, int) else None
            status = item.get("status")
            fields["status"] = status if isinstance(status, str) else None
        return event_type, fields
    return event_type, {}


def run() -> int:
    config = load_config()
    command = [config["real_codex"], *sys.argv[1:]]
    if not sys.argv[1:] or sys.argv[1] != "exec":
        return subprocess.run(command, check=False).returncode

    workspace_root = Path.cwd()
    writer = LifecycleWriter(
        Path(config["lifecycle_dir"]),
        config["collector_sha256"],
        sha256_text(str(workspace_root.resolve(strict=False))),
    )
    snapshot_excluded_paths = {Path(config["lifecycle_dir"]).resolve(strict=False)}
    observed_snapshot, observed_snapshot_truncated = snapshot_workspace(
        workspace_root,
        snapshot_excluded_paths,
    )
    process = subprocess.Popen(
        command,
        stdin=None,
        stdout=subprocess.PIPE,
        stderr=None,
    )

    def forward_signal(signum: int, _frame: Any) -> None:
        if process.poll() is None:
            process.send_signal(signum)

    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, forward_signal)

    try:
        if process.stdout is None:
            raise RuntimeError("real codex stdout pipe is unavailable")
        for raw_line in iter(process.stdout.readline, b""):
            sys.stdout.buffer.write(raw_line)
            sys.stdout.buffer.flush()
            try:
                event = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                writer.write("stream.invalid_json")
                continue
            if isinstance(event, dict):
                lifecycle = lifecycle_fields(event, workspace_root)
                if lifecycle is not None:
                    event_type, fields = lifecycle
                    writer.write(event_type, **fields)
                    call_id = fields.get("call_id")
                    if fields.get("item_type") == "command_execution" and isinstance(call_id, str) and call_id:
                        if event_type == "item.completed":
                            after, after_truncated = snapshot_workspace(workspace_root, snapshot_excluded_paths)
                            writer.write(
                                "shell_file_change.completed",
                                call_id=call_id,
                                status=fields.get("status"),
                                complete=not (observed_snapshot_truncated or after_truncated),
                                changes=diff_snapshots(observed_snapshot, after),
                            )
                            observed_snapshot = after
                            observed_snapshot_truncated = after_truncated
                    elif event_type == "file_change.completed":
                        # Native file-change events already carry the attributable
                        # delta. Advance the baseline so the next shell command does
                        # not claim the same edit a second time.
                        observed_snapshot, observed_snapshot_truncated = snapshot_workspace(
                            workspace_root,
                            snapshot_excluded_paths,
                        )
        return_code = process.wait()
        writer.write("process.exited", exit_code=return_code)
        return return_code
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()
        writer.close()


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except Exception as error:
        sys.stderr.write(f"codex lifecycle collector failed: {error}\n")
        raise SystemExit(1)
