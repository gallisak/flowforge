export interface SandboxRequest {
  expr: string;
  input: string;
  limits: { timeoutMs: number; memoryBytes: number; stackBytes: number; outputMaxChars: number };
}

export type SandboxReply = { output: string | undefined } | { error: string; retire?: boolean } | { outputTooLarge: true };

export const SANDBOX_THREAD_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const { newQuickJSWASMModule, shouldInterruptAfterDeadline } = require(workerData.quickjsPath);

function describe(name, message, limits) {
  if (message === 'interrupted') return 'transform timed out after ' + limits.timeoutMs + ' ms';
  if (message === 'out of memory') return 'transform exceeded the memory limit';
  if (message === 'stack overflow') return 'transform exceeded the stack limit';
  return 'transform failed: ' + name + ': ' + message.slice(0, 500);
}

function describeHandle(vm, handle, limits) {
  try {
    const dumped = vm.dump(handle);
    const name = dumped && typeof dumped === 'object' ? String(dumped.name || 'Error') : 'Error';
    const message = dumped && typeof dumped === 'object' ? String(dumped.message || '') : String(dumped);
    return describe(name, message, limits);
  } catch {
    return 'transform failed: the thrown value cannot be described';
  }
}

function describeThrown(encoded, limits) {
  try {
    const [name, message] = JSON.parse(encoded);
    return describe(String(name), String(message), limits);
  } catch {
    return 'transform failed: the thrown value cannot be described';
  }
}

function release(handle) {
  if (handle && handle.alive) handle.dispose();
}

function wrap(expr, outputMaxChars) {
  return '(function () {' +
    ' const ctx = JSON.parse(globalThis.__input); delete globalThis.__input;' +
    ' let out;' +
    ' try { out = JSON.stringify((function (ctx) { return (' + expr + '\\n); })(ctx)); }' +
    ' catch (thrown) {' +
    '   let name = "Error"; let message = "";' +
    '   try { name = String((thrown && thrown.name) || "Error"); } catch (ignored) {}' +
    '   try { message = String(thrown && typeof thrown === "object" && "message" in thrown ? thrown.message : thrown); } catch (ignored) {}' +
    '   return "E" + JSON.stringify([name, message]);' +
    ' }' +
    ' if (out === undefined) return "U";' +
    ' if (out.length > ' + outputMaxChars + ') return "L";' +
    ' return "J" + out;' +
    '})()';
}

function evaluate(QuickJS, request) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(request.limits.memoryBytes);
  runtime.setMaxStackSize(request.limits.stackBytes);
  const vm = runtime.newContext();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + request.limits.timeoutMs));
  let reply;
  try {
    const input = vm.newString(request.input);
    vm.setProp(vm.global, '__input', input);
    release(input);
    const result = vm.evalCode(wrap(request.expr, request.limits.outputMaxChars), 'transform.js');
    if (result.error) {
      reply = { error: describeHandle(vm, result.error, request.limits) };
      release(result.error);
    } else {
      const text = vm.typeof(result.value) === 'string' ? vm.getString(result.value) : 'U';
      release(result.value);
      if (text[0] === 'E') {
        reply = { error: describeThrown(text.slice(1), request.limits) };
      } else if (text[0] === 'L') {
        reply = { outputTooLarge: true };
      } else {
        reply = { output: text[0] === 'J' ? text.slice(1) : undefined };
      }
    }
  } finally {
    vm.dispose();
    runtime.dispose();
  }
  return reply;
}

newQuickJSWASMModule().then((QuickJS) => {
  parentPort.on('message', (request) => {
    let reply;
    try {
      reply = evaluate(QuickJS, request);
    } catch {
      parentPort.postMessage({ error: 'transform failed: the sandbox could not evaluate the expression', retire: true });
      process.exit(1);
    }
    parentPort.postMessage(reply);
  });
  parentPort.postMessage({ ready: true });
});
`;
