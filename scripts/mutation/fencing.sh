#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
exec python3 -I - "$ROOT" "$@" <<'PY'
import os, re, shutil, subprocess, sys, tempfile

root, wanted = sys.argv[1], sys.argv[2:]

MUTANTS = {
    "fence-without-attempt": {
        "about": "writes check only the worker id, so a worker that claimed the same job again after its lease expired can be overwritten by its own older attempt",
        "app": "api",
        "file": "src/engine/job-queue.service.ts",
        "edits": [
            ("""`SELECT 1 FROM jobs WHERE id = $1 AND "lockedBy" = $2 AND attempts = $3 AND status = 'running' FOR UPDATE`,
        [job.id, workerId, job.attempts],""", """`SELECT 1 FROM jobs WHERE id = $1 AND "lockedBy" = $2 AND status = 'running' FOR UPDATE`,
        [job.id, workerId],"""),
            ("return { id: job.id, lockedBy: workerId, attempts: job.attempts, status: 'running' as const };", "return { id: job.id, lockedBy: workerId, status: 'running' as const };"),
        ],
        "test": ["npx", "jest", "--ci", "test/integration/queue/write-fencing", "-t", "after the same worker claimed the job again"],
    },
    "fence-without-owner": {
        "about": "writes do not check who holds the job, so a worker that lost its lease still writes checkpoints and results",
        "app": "api",
        "file": "src/engine/job-queue.service.ts",
        "edits": [
            ("      if (owned.length !== 1) throw new LeaseLostError(job.id);\n", ""),
            ("return { id: job.id, lockedBy: workerId, attempts: job.attempts, status: 'running' as const };", "return { id: job.id };"),
        ],
        "test": ["npx", "jest", "--ci", "test/integration/queue/write-fencing", "-t", "after another worker took the job over"],
    },
}

unknown = [name for name in wanted if name not in MUTANTS]
if unknown:
    sys.stderr.write(f"unknown mutant: {', '.join(unknown)}; known: {', '.join(MUTANTS)}\n")
    sys.exit(2)

FAILED = {"api": re.compile(r"^Tests:.*\d+ failed", re.M), "frontend": re.compile(r"Tests +\d+ failed")}
PASSED = {"api": re.compile(r"^Tests:.*\d+ passed", re.M), "frontend": re.compile(r"Tests +\d+ passed")}


def copy_app(app, into):
    source = os.path.join(root, "apps", app)
    if not os.path.isdir(os.path.join(source, "node_modules")):
        sys.stderr.write(f"install dependencies first: (cd apps/{app} && npm ci)\n")
        sys.exit(2)
    target = os.path.join(into, "apps", app)
    shutil.copytree(source, target, symlinks=True, ignore=shutil.ignore_patterns("node_modules", "dist", ".next", "coverage"))
    os.symlink(os.path.join(source, "node_modules"), os.path.join(target, "node_modules"))
    os.symlink(os.path.join(root, "docker"), os.path.join(into, "docker"))
    return target


def run(command, cwd, log):
    with open(log, "w", encoding="utf-8") as out:
        status = subprocess.run(command, cwd=cwd, stdout=out, stderr=subprocess.STDOUT).returncode
    return status, open(log, encoding="utf-8", errors="replace").read()


def tail(text):
    return "\n".join(text.splitlines()[-40:])


killed, survived, broken = [], [], []
for name in wanted or list(MUTANTS):
    mutant = MUTANTS[name]
    print(f"▶ {name}: {mutant['about']}", flush=True)
    with tempfile.TemporaryDirectory(prefix=f"ff-mutation-{name}.") as tmp:
        app_dir = copy_app(mutant["app"], tmp)
        status, output = run(mutant["test"], app_dir, os.path.join(tmp, "baseline.log"))
        if status != 0 or not PASSED[mutant["app"]].search(output):
            print("  ✘ the test does not pass on the unchanged code, so a failure would prove nothing")
            print(tail(output))
            broken.append(name)
            continue
        path = os.path.join(app_dir, mutant["file"])
        source = open(path, encoding="utf-8").read()
        for original, replacement in mutant["edits"]:
            if source.count(original) != 1:
                print(f"  ✘ mutation target not found exactly once in {mutant['file']}: {original.splitlines()[0]!r}")
                broken.append(name)
                break
            source = source.replace(original, replacement)
        else:
            open(path, "w", encoding="utf-8").write(source)
            status, output = run(mutant["test"], app_dir, os.path.join(tmp, "mutant.log"))
            if status == 0:
                print("  ✘ SURVIVED: the test passes with the fence removed")
                survived.append(name)
            elif FAILED[mutant["app"]].search(output):
                print("  ✔ KILLED: green on the current code, red with the fence removed")
                killed.append(name)
            else:
                print("  ✘ the test run failed for a reason other than an assertion")
                print(tail(output))
                broken.append(name)

print(f"killed {len(killed)}, survived {len(survived)}, broken {len(broken)}")
sys.exit(2 if broken else 1 if survived else 0)
PY
