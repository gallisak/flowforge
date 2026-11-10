export interface SandboxRequest {
  expr: string;
  input: string;
  limits: { timeoutMs: number; memoryBytes: number; stackBytes: number };
}

export type SandboxReply = { output: string | undefined } | { error: string };

export const SANDBOX_THREAD_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const { newQuickJSWASMModule, shouldInterruptAfterDeadline } = require(workerData.quickjsPath);

function describe(error, limits) {
  const name = error && typeof error === 'object' ? String(error.name || 'Error') : 'Error';
  const message = error && typeof error === 'object' ? String(error.message || '') : String(error);
  if (message === 'interrupted') return 'transform timed out after ' + limits.timeoutMs + ' ms';
  if (message === 'out of memory') return 'transform exceeded the memory limit';
  if (message === 'stack overflow') return 'transform exceeded the stack limit';
  return 'transform failed: ' + name + ': ' + message.slice(0, 500);
}

newQuickJSWASMModule().then((QuickJS) => {
  parentPort.on('message', (request) => {
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(request.limits.memoryBytes);
    runtime.setMaxStackSize(request.limits.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + request.limits.timeoutMs));
    const vm = runtime.newContext();
    let reply;
    try {
      const input = vm.newString(request.input);
      vm.setProp(vm.global, '__input', input);
      input.dispose();
      const source =
        '(function () { const ctx = JSON.parse(globalThis.__input); delete globalThis.__input; ' +
        'return JSON.stringify((function (ctx) { return (' + request.expr + '\\n); })(ctx)); })()';
      const result = vm.evalCode(source, 'transform.js');
      if (result.error) {
        reply = { error: describe(vm.dump(result.error), request.limits) };
        result.error.dispose();
      } else {
        reply = { output: vm.typeof(result.value) === 'string' ? vm.getString(result.value) : undefined };
        result.value.dispose();
      }
      vm.dispose();
      runtime.dispose();
    } catch (crash) {
      parentPort.postMessage({ error: 'transform crashed the sandbox' });
      process.exit(1);
    }
    parentPort.postMessage(reply);
  });
  parentPort.postMessage({ ready: true });
});
`;
