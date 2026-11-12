import { Worker } from 'worker_threads';
import { SANDBOX_STACK_BYTES, TransformError, TransformSandbox } from '../src/engine/sandbox/transform-sandbox';

describe('TransformSandbox', () => {
  const limits = { timeoutMs: 100, memoryBytes: 16 * 1024 * 1024, stackBytes: SANDBOX_STACK_BYTES, outputMaxBytes: 1024 * 1024 };
  let sandbox: TransformSandbox;

  beforeAll(() => {
    sandbox = new TransformSandbox(limits, 2);
  });

  afterAll(async () => {
    await sandbox.close();
  });

  const failureOf = async (expr: string, input: unknown = {}) => {
    const error = await sandbox.evaluate(expr, input).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TransformError);
    return error as TransformError;
  };

  it('evaluates expressions over the step context', async () => {
    const ctx = { input: { n: 2 }, steps: { fetch: { body: { items: [1, 2, 3] } } } };
    await expect(sandbox.evaluate('ctx.steps.fetch.body.items.map((x) => x * ctx.input.n)', ctx)).resolves.toEqual([2, 4, 6]);
  });

  it('returns undefined when the expression produces no JSON value', async () => {
    await expect(sandbox.evaluate('undefined', {})).resolves.toBeUndefined();
    await expect(sandbox.evaluate('() => 1', {})).resolves.toBeUndefined();
  });

  it.each([
    'typeof process',
    'typeof require',
    'typeof module',
    'typeof Buffer',
    'typeof setTimeout',
    'typeof fetch',
    "typeof ctx.constructor.constructor('return this')().process",
  ])('hides host capabilities: %s', async (expr) => {
    await expect(sandbox.evaluate(expr, {})).resolves.toBe('undefined');
  });

  it('stops an endless loop', async () => {
    const started = Date.now();
    expect((await failureOf('(() => { for (;;) {} })()')).message).toBe('transform timed out after 100 ms');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops a computation that allocates until it runs out of memory', async () => {
    const started = Date.now();
    const error = await failureOf('(() => { const keep = []; for (;;) keep.push("y".padEnd(1e6)); })()');
    expect(error.message).toMatch(/memory limit|timed out/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rejects a single oversized allocation', async () => {
    expect((await failureOf('new Array(1e9).fill(0)')).message).toBe('transform exceeded the memory limit');
  });

  it('stops deep recursion', async () => {
    expect((await failureOf('(function f() { return f(); })()')).message).toBe('transform exceeded the stack limit');
  });

  it('rejects input nested deeper than the host can serialize', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect((await failureOf('ctx', deep)).message).toBe('transform input cannot be serialized');
  });

  it('rejects input nested deeper than the sandbox stack allows', async () => {
    const deep = JSON.parse(`${'['.repeat(20_000)}${']'.repeat(20_000)}`);
    expect((await failureOf('ctx', deep)).message).toMatch(/stack limit|cannot be serialized/);
  });

  it('reports syntax errors without host details', async () => {
    expect((await failureOf('ctx.')).message).toMatch(/^transform failed: SyntaxError/);
  });

  it('cannot change the prototypes of the host', async () => {
    await sandbox.evaluate('(Object.prototype.polluted = true, 1)', {});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('shares no state between evaluations', async () => {
    await sandbox.evaluate('(globalThis.leftover = 42, 1)', {});
    await expect(sandbox.evaluate('typeof globalThis.leftover', {})).resolves.toBe('undefined');
    await expect(sandbox.evaluate('typeof Object.prototype.polluted', {})).resolves.toBe('undefined');
  });

  it('allows the non-deterministic built-ins Date and Math.random', async () => {
    await expect(sandbox.evaluate('typeof Date.now() === "number" && Math.random() < 1', {})).resolves.toBe(true);
  });

  it('receives a copy of the context, not host objects', async () => {
    const input = { input: { when: new Date(0) }, steps: {} };
    await expect(sandbox.evaluate('typeof ctx.input.when', input)).resolves.toBe('string');
  });

  it('keeps serving after a computation was cut off', async () => {
    await failureOf('(() => { const keep = []; for (;;) keep.push("y".padEnd(1e6)); })()');
    await expect(sandbox.evaluate('1 + 1', {})).resolves.toBe(2);
  });

  it('runs more evaluations than it has threads', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => sandbox.evaluate('ctx.i * 10', { i })));
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('rejects evaluations still waiting for a thread when it shuts down', async () => {
    const single = new TransformSandbox(limits, 1);
    const running = single.evaluate('(() => { for (;;) {} })()', {}).catch((e: unknown) => e);
    const waiting = single.evaluate('1', {}).catch((e: unknown) => e);
    await single.close();
    expect(await waiting).toMatchObject({ message: 'transform sandbox is shut down', retryable: true });
    expect(await running).toBeInstanceOf(TransformError);
  });

  it.each(['(async () => 1)()', 'Promise.resolve({ ok: true })', '({ then(resolve) { resolve(1); } })', 'Object.assign(() => 1, { then() {} })'])(
    'refuses a promise or thenable result: %s',
    async (expr) => {
      const error = await failureOf(expr);
      expect(error.message).toBe('transform must return a value, not a promise');
      expect(error.retryable).toBe(false);
    },
  );

  it('keeps an object whose then field is not a function', async () => {
    await expect(sandbox.evaluate('({ then: 1 })', {})).resolves.toEqual({ then: 1 });
  });

  it('rejects an oversized result inside the sandbox', async () => {
    expect((await failureOf("'x'.repeat(2 * 1024 * 1024)")).message).toBe('step output exceeds 1048576 bytes');
    expect((await failureOf("'\u00e9'.repeat(600 * 1024)")).message).toBe('step output exceeds 1048576 bytes');
    await expect(sandbox.evaluate("'x'.repeat(1000).length", {})).resolves.toBe(1000);
  });
});

describe('TransformSandbox with hostile thrown values', () => {
  const limits = { timeoutMs: 100, memoryBytes: 16 * 1024 * 1024, stackBytes: SANDBOX_STACK_BYTES, outputMaxBytes: 1024 * 1024 };
  const hostileThrows = [
    '(() => { throw Promise.resolve(1) })()',
    '(() => { throw Promise.reject(1) })()',
    '(() => { throw { get message() { throw 1 }, get name() { throw 2 } } })()',
    '(() => { throw Symbol("x") })()',
    '(() => { throw { toString() { throw 1 } } })()',
  ];

  it.each(hostileThrows)('reports %s as a failure of that transform only', async (expr) => {
    const single = new TransformSandbox(limits, 1);
    try {
      const error = await single.evaluate(expr, {}).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TransformError);
      expect((error as TransformError).message).toMatch(/^transform failed/);
      expect((error as TransformError).retryable).toBe(false);
      await expect(single.evaluate('2 + 2', {})).resolves.toBe(4);
    } finally {
      await single.close();
    }
  });

  it('never hands a broken thread to the transform waiting next in line', async () => {
    const single = new TransformSandbox(limits, 1);
    try {
      const [attack, victims] = await Promise.all([
        single.evaluate(hostileThrows[0], {}).catch((e: unknown) => e),
        Promise.all(Array.from({ length: 3 }, (_, n) => single.evaluate('ctx.n + 1', { n }))),
      ]);
      expect(attack).toBeInstanceOf(TransformError);
      expect(victims).toEqual([1, 2, 3]);
    } finally {
      await single.close();
    }
  });

});

describe('TransformSandbox result size', () => {
  const limits = { timeoutMs: 1_000, memoryBytes: 64 * 1024 * 1024, stackBytes: SANDBOX_STACK_BYTES, outputMaxBytes: 1024 * 1024 };
  let sandbox: TransformSandbox;

  beforeAll(() => {
    sandbox = new TransformSandbox(limits, 1);
  });

  afterAll(async () => {
    await sandbox.close();
    jest.restoreAllMocks();
  });

  it('does not copy an oversized result to the host when the expression breaks out of its wrapper', async () => {
    const copied: number[] = [];
    const emit = Worker.prototype.emit;
    jest.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
      const reply = args[0] as { output?: unknown; error?: unknown } | undefined;
      if (event === 'message' && reply) copied.push(JSON.stringify(reply).length);
      return emit.call(this, event, ...args);
    });
    const escape = '0); })(ctx)); return "J" + "1".repeat(5000000); ((function (ctx) { return (0';

    const error = await sandbox.evaluate(escape, {}).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TransformError);
    expect(Math.max(...copied)).toBeLessThan(2 * 1024 * 1024);
  });

  it('cannot replace the serialisation the wrapper uses', async () => {
    await expect(sandbox.evaluate('(JSON.stringify = () => "1".repeat(5000000), { ok: true })', {})).resolves.toEqual({ ok: true });
  });
});
