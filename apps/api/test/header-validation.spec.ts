import { BadRequestException } from '@nestjs/common';
import { validateSteps } from '../src/workflows/definition';

const withHeaders = (headers: Record<string, string>) => [{ id: 'call', type: 'http', url: 'https://api.example.com/x', headers }];

describe('http step headers', () => {
  it.each(['a\u0000b', 'tab\u0007bell', 'snow ☃', 'del \u007f'])('refuses a value that cannot be sent: %j', (value) => {
    expect(() => validateSteps(withHeaders({ 'x-token': value }))).toThrow(BadRequestException);
  });

  it('accepts tabs, printable ASCII and Latin-1 characters', () => {
    expect(() => validateSteps(withHeaders({ 'x-token': 'a\tb ~ café' }))).not.toThrow();
  });

  it('refuses two names that differ only by case', () => {
    expect(() => validateSteps(withHeaders({ 'X-Token': 'a', 'x-token': 'b' }))).toThrow('steps[0].headers sets x-token twice');
  });
});
