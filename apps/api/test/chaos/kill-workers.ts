import { execSync } from 'child_process';
import { join } from 'path';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const SINK_URL = process.env.SINK_URL ?? 'http://localhost:18080';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'change-me-admin';
const COMPOSE = process.env.COMPOSE ?? 'docker compose -p flowforge -f docker-compose.yml -f docker-compose.chaos.yml';
const EXECUTIONS = Number(process.env.EXECUTIONS ?? 10);
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const EFFECT_PATHS = ['/reserve', '/charge', '/email'];

interface StepView {
  stepId: string;
  status: string;
  attempts: number;
}

interface ExecutionView {
  id: string;
  status: string;
  error: string | null;
  finishedAt: string | null;
  steps: StepView[];
}

interface SinkStats {
  requests: Array<{ path: string; key: string; applied: boolean }>;
  inFlight: number;
  notifications: Array<{ webhookId: string; executionId: string; status: string }>;
}

interface RunStats {
  requests: Record<string, number>;
  effects: Record<string, number>;
  deliveries: number;
  distinctNotifications: number;
}

function statsOfRun(stats: SinkStats, executionIds: readonly string[]): RunStats {
  const ours = new Set(executionIds);
  const requests = stats.requests.filter((r) => ours.has(r.key.split(':')[0]));
  const notifications = stats.notifications.filter((n) => ours.has(n.executionId));
  const countBy = (rows: typeof requests) =>
    rows.reduce<Record<string, number>>((table, r) => ({ ...table, [r.path]: (table[r.path] ?? 0) + 1 }), {});
  return {
    requests: countBy(requests),
    effects: countBy(requests.filter((r) => r.applied)),
    deliveries: notifications.length,
    distinctNotifications: new Set(notifications.map((n) => n.webhookId)).size,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line: string) => process.stdout.write(`${line}\n`);
const compose = (args: string) => execSync(`${COMPOSE} ${args}`, { cwd: REPO_ROOT, stdio: 'pipe' }).toString().trim();

async function call<T>(base: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function waitFor<T>(description: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const tenant = await call<{ id: string; apiKey: string }>(API_URL, 'POST', '/tenants', { 'x-admin-token': ADMIN_TOKEN }, { name: `chaos-${Date.now()}` });
  const auth = { 'x-api-key': tenant.apiKey };
  await call(API_URL, 'PUT', '/notifications/endpoint', auth, { url: 'http://sink:8080/notify' });
  const effect = (id: string, path: string) => ({
    id,
    type: 'http',
    method: 'POST',
    url: `http://sink:8080${path}`,
    headers: { 'content-type': 'application/json' },
    body: '{"order":"{{ input.order }}"}',
  });
  const workflow = await call<{ id: string }>(API_URL, 'POST', '/workflows', auth, {
    name: 'chaos order',
    steps: [effect('reserve', '/reserve'), effect('charge', '/charge'), { id: 'cool_down', type: 'delay', ms: 2000 }, effect('email', '/email')],
  });
  await call(SINK_URL, 'POST', '/reset');

  const startedAt = Date.now();
  const ids: string[] = [];
  for (let order = 0; order < EXECUTIONS; order++) {
    ids.push((await call<{ id: string }>(API_URL, 'POST', `/workflows/${workflow.id}/run`, auth, { order: `order-${order}` })).id);
  }
  log(`started ${EXECUTIONS} executions of reserve -> charge -> delay 2 s -> email`);

  const held = await waitFor('charges in flight', 60_000, async () => {
    const stats = await call<SinkStats>(SINK_URL, 'GET', '/stats');
    return stats.inFlight >= Math.min(4, EXECUTIONS) ? stats.inFlight : undefined;
  });
  const workers = compose('ps -q worker').split('\n').filter(Boolean);
  execSync(`docker kill -s KILL ${workers.join(' ')}`, { stdio: 'pipe' });
  const killedAt = Date.now();
  log(`SIGKILL to ${workers.length} worker containers while ${held} charge requests were in flight`);
  await sleep(2000);
  compose('up -d --no-deps worker');
  log('workers restarted');

  await waitFor('all executions to finish', 5 * 60_000, async () => {
    const page = await call<ExecutionView[]>(API_URL, 'GET', `/executions?workflowId=${workflow.id}&limit=200`, auth);
    return page.length === EXECUTIONS && page.every((v) => v.status === 'succeeded' || v.status === 'failed') ? page : undefined;
  });
  const finished = await Promise.all(ids.map((id) => call<ExecutionView>(API_URL, 'GET', `/executions/${id}`, auth)));
  const lastFinishedAt = Math.max(...finished.map((v) => new Date(v.finishedAt ?? 0).getTime()));
  const recoveredSeconds = (lastFinishedAt - killedAt) / 1000;
  const stats = await waitFor('notifications', 120_000, async () => {
    const current = statsOfRun(await call<SinkStats>(SINK_URL, 'GET', '/stats'), ids);
    return current.distinctNotifications >= EXECUTIONS ? current : undefined;
  });

  const attempts = (stepId: string) => {
    const histogram: Record<string, number> = {};
    for (const view of finished) {
      const step = view.steps.find((s) => s.stepId === stepId);
      const key = String(step?.attempts ?? 0);
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
    return Object.entries(histogram)
      .map(([n, executions]) => `${executions}x ${n}`)
      .join(', ');
  };

  const succeeded = finished.filter((v) => v.status === 'succeeded').length;
  log('');
  log(`the last execution finished ${recoveredSeconds.toFixed(1)} s after the kill, ${((lastFinishedAt - startedAt) / 1000).toFixed(1)} s after the start`);
  log(`succeeded: ${succeeded} of ${EXECUTIONS}`);
  log('');
  log('| step | attempts per execution | requests received | effects applied |');
  log('|---|---|---|---|');
  for (const path of EFFECT_PATHS) {
    const stepId = path.slice(1);
    log(`| ${stepId} | ${attempts(stepId)} | ${stats.requests[path] ?? 0} | ${stats.effects[path] ?? 0} |`);
  }
  log('');
  log(`notifications: ${stats.deliveries} deliveries, ${stats.distinctNotifications} distinct webhook ids`);

  const problems = [
    succeeded !== EXECUTIONS && `${EXECUTIONS - succeeded} executions did not succeed`,
    ...EFFECT_PATHS.filter((path) => stats.effects[path] !== EXECUTIONS).map((path) => `${path} was applied ${stats.effects[path] ?? 0} times`),
    finished.some((v) => v.steps.find((s) => s.stepId === 'reserve')?.attempts !== 1) && 'a completed reserve step was run again',
    stats.distinctNotifications !== EXECUTIONS && `${stats.distinctNotifications} distinct notifications instead of ${EXECUTIONS}`,
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`guarantees violated: ${problems.join('; ')}`);
  log('every effect was applied exactly once and no completed step ran again');
}

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
