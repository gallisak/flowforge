import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT_ENV = join(__dirname, '..', '..', '..', '..', '.env');

export function fromEnvOrRootEnvFile(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  if (!existsSync(ROOT_ENV)) return '';
  const line = readFileSync(ROOT_ENV, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : '';
}
