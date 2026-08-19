#!/usr/bin/env python3
"""Transparent Codex proxy that records output-event arrival times.

The wrapper is copied into a private run directory as ``codex``. Its sibling
configuration names the real binary and lifecycle output directory, so no
collector-specific environment variable needs to enter the agent process.
"""

from __future__ import annotations

import json
import os
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


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
    def __init__(self, directory: Path, collector_sha256: str) -> None:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        filename = f"codex-{time.time_ns()}-{os.getpid()}-{secrets.token_hex(4)}.ndjson"
        path = directory / filename
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self._handle = os.fdopen(descriptor, "w", encoding="utf-8", buffering=1)
        self._started_ns = time.monotonic_ns()
        self._sequence = 0
        self.write("collector.started", collector_sha256=collector_sha256, collector_version="1")

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


def lifecycle_fields(event: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    event_type = event.get("type")
    if event_type not in SUPPORTED_EVENTS:
        return None
    if event_type == "thread.started":
        thread_id = event.get("thread_id")
        return event_type, {"thread_id": thread_id} if isinstance(thread_id, str) else {}
    if event_type in {"item.started", "item.completed"}:
        item = event.get("item")
        if not isinstance(item, dict) or item.get("type") != "command_execution":
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

    writer = LifecycleWriter(Path(config["lifecycle_dir"]), config["collector_sha256"])
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
                lifecycle = lifecycle_fields(event)
                if lifecycle is not None:
                    event_type, fields = lifecycle
                    writer.write(event_type, **fields)
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
