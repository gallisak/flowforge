import { ChildProcess, spawn } from 'child_process';
import { join } from 'path';

const API_ROOT = join(__dirname, '..', '..');

export type AppEntrypoint = 'main' | 'worker' | 'scheduler' | 'migrate';

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface AppProcess {
  readonly child: ChildProcess;
  output(): string;
  waitForOutput(pattern: RegExp, timeoutMs?: number): Promise<void>;
  waitForExit(timeoutMs?: number): Promise<ProcessExit>;
  kill(signal?: NodeJS.Signals): Promise<ProcessExit>;
}

export function spawnAppProcess(entrypoint: AppEntrypoint, env: Record<string, string> = {}): AppProcess {
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', join(API_ROOT, 'src', `${entrypoint}.ts`)],
    {
      cwd: API_ROOT,
      env: {
        ...process.env,
        TS_NODE_PROJECT: join(API_ROOT, 'tsconfig.json'),
        NO_COLOR: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let buffer = '';
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const isRunning = () => child.exitCode === null && child.signalCode === null;

  return {
    child,
    output: () => buffer,
    waitForOutput(pattern, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (pattern.test(buffer)) {
            cleanup();
            resolve();
          }
        };
        const onExit = () => {
          cleanup();
          reject(new Error(`Process ${entrypoint} exited before ${pattern} appeared:\n${buffer}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${pattern}:\n${buffer}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout?.off('data', check);
          child.stderr?.off('data', check);
          child.off('exit', onExit);
        };
        child.stdout?.on('data', check);
        child.stderr?.on('data', check);
        child.once('exit', onExit);
        check();
      });
    },
    waitForExit(timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Process ${entrypoint} still running after ${timeoutMs} ms:\n${buffer}`));
        }, timeoutMs);
        void exited.then((exit) => {
          clearTimeout(timer);
          resolve(exit);
        });
      });
    },
    async kill(signal = 'SIGKILL') {
      if (isRunning()) child.kill(signal);
      return exited;
    },
  };
}
