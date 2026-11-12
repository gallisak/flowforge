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

function runnerSource(outputMaxChars) {
  return '(function () {' +
    ' const parse = JSON.parse; const stringify = JSON.stringify; const toText = String;' +
    ' const input = globalThis.__input; delete globalThis.__input;' +
    ' return function (transform) {' +
    '   let out;' +
    '   try { out = stringify(transform(parse(input))); }' +
    '   catch (thrown) {' +
    '     let name = "Error"; let message = "";' +
    '     try { name = toText((thrown && thrown.name) || "Error"); } catch (ignored) {}' +
    '     try { message = toText(thrown && typeof thrown === "object" && "message" in thrown ? thrown.message : thrown); } catch (ignored) {}' +
    '     return "E" + stringify([name, message.length > 1000 ? message.slice(0, 1000) : message]);' +
    '   }' +
    '   if (typeof out !== "string") return "U";' +
    '   if (out.length > ' + outputMaxChars + ') return "L";' +
    '   return "J" + out;' +
    ' };' +
    '})()';
}

function compiledSource(expr) {
  return '(function (ctx) { return (' + expr + '\\n); })';
}

function textOf(vm, handle, maxChars) {
  if (vm.typeof(handle) !== 'string') return 'U';
  const lengthHandle = vm.getProp(handle, 'length');
  const length = vm.getNumber(lengthHandle);
  release(lengthHandle);
  if (length > maxChars) return 'L';
  return vm.getString(handle);
}

function evaluate(QuickJS, request) {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(request.limits.memoryBytes);
  runtime.setMaxStackSize(request.limits.stackBytes);
  const vm = runtime.newContext();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + request.limits.timeoutMs));
  const handles = [];
  const keep = (handle) => {
    handles.push(handle);
    return handle;
  };
  let reply;
  try {
    const input = vm.newString(request.input);
    vm.setProp(vm.global, '__input', input);
    release(input);
    const runner = vm.evalCode(runnerSource(request.limits.outputMaxChars), 'runner.js');
    if (runner.error) {
      keep(runner.error);
      return { error: describeHandle(vm, runner.error, request.limits) };
    }
    keep(runner.value);
    const compiled = vm.evalCode(compiledSource(request.expr), 'transform.js');
    if (compiled.error) {
      keep(compiled.error);
      return { error: describeHandle(vm, compiled.error, request.limits) };
    }
    keep(compiled.value);
    if (vm.typeof(compiled.value) !== 'function') return { error: 'transform failed: SyntaxError: the expression must be a single expression' };
    const result = vm.callFunction(runner.value, vm.undefined, compiled.value);
    if (result.error) {
      keep(result.error);
      return { error: describeHandle(vm, result.error, request.limits) };
    }
    keep(result.value);
    const text = textOf(vm, result.value, request.limits.outputMaxChars + 1);
    if (text[0] === 'E') {
      reply = { error: describeThrown(text.slice(1), request.limits) };
    } else if (text[0] === 'L') {
      reply = { outputTooLarge: true };
    } else {
      reply = { output: text[0] === 'J' ? text.slice(1) : undefined };
    }
  } finally {
    for (const handle of handles) release(handle);
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
