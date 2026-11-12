#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
exec python3 -I - "$ROOT" "$@" <<'PY'
import os, re, shutil, subprocess, sys, tempfile

root, wanted = sys.argv[1], sys.argv[2:]

MUTANTS = {
    "non-atomic-completion": {
        "about": "the job is marked done in one transaction and the execution and its notification in another, as the starter did",
        "app": "api",
        "file": "src/engine/job-queue.service.ts",
        "edits": [(
            """  complete(job: Job, workerId: string, execution: ExecutionUpdate): Promise<boolean> {
    return this.db.run(job.tenantId, async (em) => {
      const result = await em.update(Job, this.ownedBy(job, workerId), {
        status: 'done',
        lockedBy: null,
        lockedUntil: null,
      });
      if (result.affected !== 1) return false;
      await em.update(Execution, job.executionId, { ...execution, error: null });
      await recordExecutionEvent(em, job.executionId);
      return true;
    });
  }""",
            """  async complete(job: Job, workerId: string, execution: ExecutionUpdate): Promise<boolean> {
    const owned = await this.db.run(job.tenantId, async (em) => {
      const result = await em.update(Job, this.ownedBy(job, workerId), { status: 'done', lockedBy: null, lockedUntil: null });
      return result.affected === 1;
    });
    if (!owned) return false;
    await this.db.run(job.tenantId, async (em) => {
      await em.update(Execution, job.executionId, { ...execution, error: null });
      await recordExecutionEvent(em, job.executionId);
    });
    return true;
  }""",
        )],
        "test": ["npx", "jest", "--ci", "test/integration/outbox/notifications", "-t", "same transaction as the final state"],
    },
    "database-timeouts": {
        "about": "the database connection has no connect, statement or client timeouts, as in the starter",
        "app": "api",
        "file": "src/db/data-source.ts",
        "edits": [(
            "poolSize?: number): DataSourceOptions {\n",
            "poolSize?: number): DataSourceOptions {\n  timeouts = ([] as DatabaseTimeouts[])[0];\n",
        )],
        "test": ["npx", "jest", "--ci", "test/integration/db/timeouts"],
    },
    "admin-token-after-validation": {
        "about": "the admin token is checked inside the handler, after the body was validated, as in the starter",
        "app": "api",
        "file": "src/tenants/tenants.controller.ts",
        "edits": [
            ("import { Body, Controller, NotFoundException,", "import { Body, Controller, ForbiddenException, Headers, NotFoundException,"),
            ("@Controller('tenants')\n@UseGuards(AdminTokenGuard)\n", "@Controller('tenants')\n"),
            (
                "  async create(@Body() dto: CreateTenantDto) {\n",
                "  async create(@Body() dto: CreateTenantDto, @Headers('x-admin-token') admin?: string) {\n"
                "    if (!admin || admin !== process.env.ADMIN_TOKEN) throw new ForbiddenException();\n",
            ),
            ("  @Patch(':id/limits')\n", "  @Patch(':id/limits')\n  @UseGuards(AdminTokenGuard)\n"),
        ],
        "test": ["npx", "jest", "--ci", "test/integration/tenancy/admin-endpoint"],
    },
    "proxy-without-timeout": {
        "about": "the frontend proxy calls the API without a deadline, as in the starter",
        "app": "frontend",
        "file": "app/api/proxy/[...path]/route.ts",
        "edits": [("      cache: 'no-store',\n      signal: AbortSignal.timeout(API_TIMEOUT_MS),\n", "      cache: 'no-store',\n")],
        "test": ["npx", "vitest", "run", "test/proxy-route.test.ts", "-t", "deadline"],
    },
    "proxy-without-path-check": {
        "about": "the frontend proxy forwards any path segment, as in the starter",
        "app": "frontend",
        "file": "app/api/proxy/[...path]/route.ts",
        "edits": [("  if (!path.every((segment) => SAFE_SEGMENT.test(segment))) return problem(400, 'Invalid path');\n", "")],
        "test": ["npx", "vitest", "run", "test/proxy-route.test.ts", "-t", "path segments"],
    },
    "connect-without-origin-check": {
        "about": "POST /api/connect stores a key posted by any site (login CSRF), as in the starter",
        "app": "frontend",
        "file": "app/api/connect/route.ts",
        "edits": [(
            "export async function POST(req: NextRequest) {\n  if (!isSameOrigin(req)) return problem(403, 'Cross-site requests are not allowed');\n",
            "export async function POST(req: NextRequest) {\n",
        )],
        "test": ["npx", "vitest", "run", "test/connect-route.test.ts", "-t", "another site"],
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
                print("  ✘ SURVIVED: the test passes with the starter defect put back")
                survived.append(name)
            elif FAILED[mutant["app"]].search(output):
                print("  ✔ KILLED: green on the current code, red with the starter defect put back")
                killed.append(name)
            else:
                print("  ✘ the test run failed for a reason other than an assertion")
                print(tail(output))
                broken.append(name)

print(f"killed {len(killed)}, survived {len(survived)}, broken {len(broken)}")
sys.exit(2 if broken else 1 if survived else 0)
PY
