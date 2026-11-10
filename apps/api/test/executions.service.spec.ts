import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Execution, StepRun } from '../src/entities';
import { ExecutionsService } from '../src/executions/executions.service';

describe('ExecutionsService tenant isolation', () => {
  let service: ExecutionsService;
  const executionsRepo = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
  const stepRunsRepo = { find: jest.fn().mockResolvedValue([]) };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ExecutionsService,
        { provide: getDataSourceToken(), useValue: {} },
        { provide: getRepositoryToken(Execution), useValue: executionsRepo },
        { provide: getRepositoryToken(StepRun), useValue: stepRunsRepo },
      ],
    }).compile();
    service = moduleRef.get(ExecutionsService);
  });

  it('does not list executions that belong to another tenant', async () => {
    const result = await service.list('tenant-a');
    expect(result).toEqual([]);
  });
});
