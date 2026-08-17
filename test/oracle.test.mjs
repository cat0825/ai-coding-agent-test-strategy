import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTasktrackerOracle, TASKTRACKER_ORACLE_TASKS } from "../src/oracle.mjs";

const environmentDigest = "a".repeat(64);
const revision = "9".repeat(40);

function environment() {
  return {
    schema_version: 1,
    evidence_class: "benchmark_environment",
    benchmark_id: "coding-agent-agent-belt-pilot",
    repository: { identity: "jfrog/agent-belt", expected_revision: revision, observed_revision: revision, clean: true },
    conclusion: { status: "eligible", reasons: [] },
  };
}

const badModels = `import time
from dataclasses import dataclass, field

@dataclass
class Task:
    id: int
    title: str
    project: str = "default"
    done: bool = False
    created_at: float = field(default_factory=time.time)

    def to_dict(self):
        return {"id": self.id, "title": self.title, "project": self.project, "done": self.done, "created_at": self.created_at}

    @classmethod
    def from_dict(cls, data):
        return cls(id=data["id"], title=data["title"], project=data.get("project", "default"), done=data.get("done", False), created_at=data.get("created_at", 0))
`;

const goodModels = `import time
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class Task:
    id: int
    title: str
    project: str = "default"
    done: bool = False
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None

    def to_dict(self):
        return {"id": self.id, "title": self.title, "project": self.project, "done": self.done, "created_at": self.created_at, "completed_at": self.completed_at}

    @classmethod
    def from_dict(cls, data):
        return cls(id=data["id"], title=data["title"], project=data.get("project", "default"), done=data.get("done", False), created_at=data.get("created_at", 0), completed_at=data.get("completed_at"))
`;

const badFormatters = `import json

def format_table(tasks):
    if not tasks:
        return "No tasks found."
    headers = ["ID", "Title", "Project", "Status"]
    rows = [[str(t.id), t.title, t.project, "done" if t.done else "pending"] for t in tasks]
    widths = [len(value) for value in headers]
    lines = ["  ".join(value.ljust(width) for value, width in zip(headers, widths)), "  ".join("-" * width for width in widths)]
    lines.extend("  ".join(value.ljust(width) for value, width in zip(row, widths)) for row in rows)
    return "\\n".join(lines)

def format_json(tasks):
    return json.dumps([task.to_dict() for task in tasks], indent=2)
`;

const goodFormatters = badFormatters.replace(
  "widths = [len(value) for value in headers]",
  "widths = [max(len(headers[index]), *(len(row[index]) for row in rows)) for index in range(len(headers))]",
);

const badStorage = `import json
import os

DEFAULT_PATH = os.path.expanduser("~/.tasktracker.json")

def load_tasks(path=DEFAULT_PATH):
    if not os.path.exists(path):
        return []
    from tasktracker.models import Task
    with open(path, "r") as handle:
        return [Task.from_dict(item) for item in json.load(handle)]

def save_tasks(tasks, path=DEFAULT_PATH):
    with open(path, "w") as handle:
        json.dump([task.to_dict() for task in tasks], handle)

def next_id(tasks):
    return max((task.id for task in tasks), default=0) + 1
`;

const goodStorage = `${badStorage}
def delete_task(task_id, path=DEFAULT_PATH):
    tasks = load_tasks(path)
    remaining = [task for task in tasks if task.id != task_id]
    if len(remaining) == len(tasks):
        return False
    save_tasks(remaining, path)
    return True
`;

const badCli = `import argparse
import sys
from tasktracker.formatters import format_table
from tasktracker.models import Task
from tasktracker.storage import load_tasks, next_id, save_tasks

def build_parser():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command")
    add = commands.add_parser("add")
    add.add_argument("title")
    listing = commands.add_parser("list")
    listing.add_argument("--project", default=None)
    done = commands.add_parser("done")
    done.add_argument("task_id", type=int)
    return parser

def cmd_add(args):
    tasks = load_tasks()
    task = Task(id=next_id(tasks), title=args.title)
    tasks.append(task)
    save_tasks(tasks)
    print(f"Added task {task.id}: {task.title}")

def cmd_list(args):
    print(format_table(load_tasks()))

def cmd_done(args):
    tasks = load_tasks()
    for task in tasks:
        if task.id == args.task_id:
            task.done = True
            save_tasks(tasks)
            print("done")
            return
    raise SystemExit(1)

def main():
    args = build_parser().parse_args()
    {"add": cmd_add, "list": cmd_list, "done": cmd_done}[args.command](args)

if __name__ == "__main__":
    main()
`;

const goodCli = `import argparse
import sys
import time
from tasktracker.formatters import format_json, format_table
from tasktracker.models import Task
from tasktracker.storage import delete_task, load_tasks, next_id, save_tasks

def build_parser():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command")
    add = commands.add_parser("add")
    add.add_argument("title")
    listing = commands.add_parser("list")
    listing.add_argument("--project", default=None)
    listing.add_argument("--format", choices=["table", "json"], default="table")
    done = commands.add_parser("done")
    done.add_argument("task_id", type=int)
    delete = commands.add_parser("delete")
    delete.add_argument("task_id", type=int)
    return parser

def cmd_add(args):
    tasks = load_tasks()
    task = Task(id=next_id(tasks), title=args.title)
    tasks.append(task)
    save_tasks(tasks)
    print(f"Added task {task.id}: {task.title}")

def cmd_list(args):
    tasks = load_tasks()
    print(format_json(tasks) if args.format == "json" else format_table(tasks))

def cmd_done(args):
    tasks = load_tasks()
    for task in tasks:
        if task.id == args.task_id:
            task.done = True
            task.completed_at = time.time()
            save_tasks(tasks)
            print("done")
            return
    raise SystemExit(1)

def cmd_delete(args):
    if not delete_task(args.task_id):
        raise SystemExit(1)
    print("deleted")

def main():
    args = build_parser().parse_args()
    {"add": cmd_add, "list": cmd_list, "done": cmd_done, "delete": cmd_delete}[args.command](args)

if __name__ == "__main__":
    main()
`;

async function createFixture(directory, correct) {
  const packageDirectory = path.join(directory, "src", "tasktracker");
  await mkdir(packageDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(packageDirectory, "__init__.py"), ""),
    writeFile(path.join(packageDirectory, "models.py"), correct ? goodModels : badModels),
    writeFile(path.join(packageDirectory, "formatters.py"), correct ? goodFormatters : badFormatters),
    writeFile(path.join(packageDirectory, "storage.py"), correct ? goodStorage : badStorage),
    writeFile(path.join(packageDirectory, "cli.py"), correct ? goodCli : badCli),
  ]);
}

test("all four independent oracles fail the unmodified behavior fixture", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-bad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createFixture(directory, false);
  for (const taskId of TASKTRACKER_ORACLE_TASKS) {
    const report = await runTasktrackerOracle({ taskId, repoRoot: directory, environment: environment(), environmentSourceDigest: environmentDigest, allowHost: true });
    assert.equal(report.result.status, "failed", taskId);
    assert.ok(report.result.failure_signatures.length > 0, taskId);
    assert.equal(report.eligibility.baseline_quality_claim_eligible, false);
  }
  await writeFile(path.join(directory, "src", "tasktracker", "models.py"), "def broken(:\n");
  const syntaxFailure = await runTasktrackerOracle({ taskId: "l2_add_completed_at", repoRoot: directory, environment: environment(), environmentSourceDigest: environmentDigest, allowHost: true });
  assert.equal(syntaxFailure.result.status, "failed");
  assert.deepEqual(syntaxFailure.result.failure_signatures, ["completed_at_model_unavailable"]);
});

test("all four independent oracles pass a known-correct behavior fixture", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-good-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createFixture(directory, true);
  for (const taskId of TASKTRACKER_ORACLE_TASKS) {
    const report = await runTasktrackerOracle({ taskId, repoRoot: directory, environment: environment(), environmentSourceDigest: environmentDigest, allowHost: true });
    assert.equal(report.result.status, "passed", `${taskId}: ${report.result.failure_signatures.join(",")}`);
    assert.deepEqual(report.result.failure_signatures, []);
  }
});

test("rejects unsupported tasks, ineligible environments, and declared eligibility", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await createFixture(directory, true);
  await assert.rejects(runTasktrackerOracle({ taskId: "l1_find_bug", repoRoot: directory, environment: environment(), environmentSourceDigest: environmentDigest, allowHost: true }), /unsupported task_id/);
  const ineligible = environment();
  ineligible.conclusion.status = "ineligible";
  await assert.rejects(runTasktrackerOracle({ taskId: TASKTRACKER_ORACLE_TASKS[0], repoRoot: directory, environment: ineligible, environmentSourceDigest: environmentDigest, allowHost: true }), /must be eligible/);
  const forged = environment();
  forged.quality_claim_eligible = true;
  await assert.rejects(runTasktrackerOracle({ taskId: TASKTRACKER_ORACLE_TASKS[0], repoRoot: directory, environment: forged, environmentSourceDigest: environmentDigest, allowHost: true }), /must not declare/);
  await assert.rejects(runTasktrackerOracle({ taskId: TASKTRACKER_ORACLE_TASKS[0], repoRoot: directory, environment: environment(), environmentSourceDigest: environmentDigest }), /explicit allowHost/);
});

test("CLI writes deterministic evidence without local paths or raw process output", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oracle-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repoDirectory = path.join(directory, "repo");
  await createFixture(repoDirectory, true);
  const environmentPath = path.join(directory, "environment.json");
  const outputPath = path.join(directory, "oracle.json");
  await writeFile(environmentPath, `${JSON.stringify(environment(), null, 2)}\n`);
  const args = ["src/oracle-cli.mjs", "--task", "l2_fix_formatter_bug", "--repo", repoDirectory, "--environment", environmentPath, "--output", outputPath, "--allow-host"];
  execFileSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  const first = await readFile(outputPath, "utf8");
  execFileSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8" });
  const second = await readFile(outputPath, "utf8");
  assert.equal(second, first);
  assert.equal(JSON.parse(first).result.status, "passed");
  assert.doesNotMatch(first, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(first, /stdout|stderr|command|PYTHONPATH/);
});
