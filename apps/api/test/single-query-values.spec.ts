import { BadRequestException } from '@nestjs/common';
import { SingleQueryValuesPipe } from '../src/common/single-query-values.pipe';

describe('SingleQueryValuesPipe', () => {
  const pipe = new SingleQueryValuesPipe();

  it('refuses a repeated parameter in a query object', () => {
    expect(() => pipe.transform({ limit: ['1', '2'] }, { type: 'query' })).toThrow(new BadRequestException('query parameter limit must be given once'));
  });

  it('refuses a repeated parameter bound by name', () => {
    expect(() => pipe.transform(['a', 'b'], { type: 'query', data: 'status' })).toThrow(new BadRequestException('query parameter status must be given once'));
  });

  it('passes single values and other arguments through', () => {
    expect(pipe.transform({ limit: '1' }, { type: 'query' })).toEqual({ limit: '1' });
    expect(pipe.transform('a', { type: 'query', data: 'status' })).toBe('a');
    expect(pipe.transform(['a', 'b'], { type: 'body' })).toEqual(['a', 'b']);
  });
});
