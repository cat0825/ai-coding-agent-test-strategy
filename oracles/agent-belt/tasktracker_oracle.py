#!/usr/bin/env python3
"""Independent functional oracles for agent-belt's tasktracker fixture."""

from __future__ import annotations

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from argparse import Namespace
from pathlib import Path

RESULT_PREFIX = "AGENT_TEST_ORACLE_RESULT="


def completed_at_oracle() -> list[str]:
    failures: list[str] = []
    try:
        from tasktracker.models import Task
    except Exception:
        return ["completed_at_model_unavailable"]

    try:
        task = Task(id=1, title="oracle")
    except Exception:
        return ["completed_at_model_unavailable"]
    if not hasattr(task, "completed_at") or task.completed_at is not None:
        failures.append("completed_at_default_invalid")

    try:
        serialized = Task(id=2, title="serialized", completed_at=42.5).to_dict()
        if serialized.get("completed_at") != 42.5:
            failures.append("completed_at_serialization_invalid")
    except Exception:
        failures.append("completed_at_serialization_invalid")

    try:
        restored = Task.from_dict({"id": 3, "title": "restored", "completed_at": 84.5})
        legacy = Task.from_dict({"id": 4, "title": "legacy", "done": True})
        if getattr(restored, "completed_at", None) != 84.5 or getattr(legacy, "completed_at", "missing") is not None:
            failures.append("completed_at_deserialization_invalid")
    except Exception:
        failures.append("completed_at_deserialization_invalid")

    try:
        from tasktracker import cli

        transition = Task(id=5, title="transition")
        saved: list[list[Task]] = []
        cli.load_tasks = lambda: [transition]
        cli.save_tasks = lambda tasks: saved.append(tasks)
        before = time.time()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            cli.cmd_done(Namespace(task_id=5))
        after = time.time()
        completed_at = getattr(transition, "completed_at", None)
        if transition.done is not True or not isinstance(completed_at, (int, float)) or not before <= completed_at <= after:
            failures.append("completed_at_transition_invalid")
        if saved != [[transition]]:
            failures.append("completed_at_persistence_missing")
    except Exception:
        failures.append("completed_at_transition_invalid")
    return sorted(set(failures))


def formatter_oracle() -> list[str]:
    try:
        from tasktracker.formatters import format_table
        from tasktracker.models import Task

        tasks = [
            Task(id=123, title="A title wider than its header", project="x", done=False),
            Task(id=7, title="short", project="a-project-wider-than-header", done=True),
        ]
        lines = format_table(tasks).splitlines()
    except Exception:
        return ["formatter_api_unavailable"]
    failures = []
    if len(lines) != 4 or len({len(line) for line in lines}) != 1:
        failures.append("formatter_column_alignment_invalid")
    if not all(value in "\n".join(lines) for value in [tasks[0].title, tasks[1].project]):
        failures.append("formatter_value_missing")
    return failures


def run_cli(arguments: list[str], home: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment["HOME"] = home
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return subprocess.run(
        [sys.executable, "-m", "tasktracker.cli", *arguments],
        cwd=os.getcwd(),
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )


def delete_oracle() -> list[str]:
    failures: list[str] = []
    try:
        from tasktracker.models import Task
        from tasktracker.storage import delete_task, load_tasks, save_tasks
    except Exception:
        return ["delete_api_unavailable"]

    with tempfile.TemporaryDirectory(prefix="tasktracker-delete-oracle-") as directory:
        storage_path = Path(directory) / "tasks.json"
        try:
            save_tasks([Task(id=1, title="remove"), Task(id=2, title="keep")], str(storage_path))
            delete_task(1, str(storage_path))
            if [task.id for task in load_tasks(str(storage_path))] != [2]:
                failures.append("delete_storage_behavior_invalid")
            delete_task(99, str(storage_path))
            if [task.id for task in load_tasks(str(storage_path))] != [2]:
                failures.append("delete_missing_id_corrupts_storage")
        except Exception:
            failures.append("delete_storage_behavior_invalid")

        home = str(Path(directory) / "home")
        Path(home).mkdir()
        try:
            added = run_cli(["add", "Disposable"], home)
            deleted = run_cli(["delete", "1"], home)
            listed = run_cli(["list"], home)
            missing = run_cli(["delete", "99"], home)
            if added.returncode != 0 or deleted.returncode != 0 or listed.returncode != 0:
                failures.append("delete_cli_flow_invalid")
            if "No tasks found" not in listed.stdout or missing.returncode == 0:
                failures.append("delete_cli_flow_invalid")
        except (OSError, subprocess.SubprocessError):
            failures.append("delete_cli_flow_invalid")
    return sorted(set(failures))


def json_format_oracle() -> list[str]:
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="tasktracker-json-oracle-") as directory:
        home = Path(directory) / "home"
        home.mkdir()
        (home / ".tasktracker.json").write_text(
            json.dumps(
                [
                    {
                        "id": 7,
                        "title": "Oracle task",
                        "project": "verification",
                        "done": False,
                        "created_at": 1000.0,
                    }
                ]
            ),
            encoding="utf-8",
        )
        try:
            json_result = run_cli(["list", "--format", "json"], str(home))
            table_result = run_cli(["list"], str(home))
            invalid_result = run_cli(["list", "--format", "yaml"], str(home))
        except (OSError, subprocess.SubprocessError):
            return ["json_cli_execution_failed"]
        if json_result.returncode != 0:
            failures.append("json_format_unavailable")
        else:
            try:
                payload = json.loads(json_result.stdout)
                if len(payload) != 1 or payload[0].get("id") != 7 or payload[0].get("title") != "Oracle task":
                    failures.append("json_payload_invalid")
            except (json.JSONDecodeError, TypeError, AttributeError):
                failures.append("json_payload_invalid")
        if table_result.returncode != 0 or "Oracle task" not in table_result.stdout:
            failures.append("json_default_table_regressed")
        if invalid_result.returncode == 0:
            failures.append("json_invalid_choice_accepted")
    return sorted(set(failures))


ORACLES = {
    "l2_add_completed_at": completed_at_oracle,
    "l2_fix_formatter_bug": formatter_oracle,
    "l3_add_delete_command": delete_oracle,
    "l3_add_json_format": json_format_oracle,
}


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ORACLES:
        print(RESULT_PREFIX + json.dumps({"status": "invalid", "failure_signatures": ["oracle_task_unknown"]}))
        return 2
    try:
        failures = ORACLES[sys.argv[1]]()
    except Exception as error:  # The type is evidence; messages may contain local paths.
        print(
            RESULT_PREFIX
            + json.dumps(
                {
                    "status": "invalid",
                    "failure_signatures": [f"oracle_execution_error:{type(error).__name__}"],
                },
                sort_keys=True,
            )
        )
        return 2
    status = "failed" if failures else "passed"
    print(RESULT_PREFIX + json.dumps({"status": status, "failure_signatures": failures}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
