import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Execution, Job, StepRun, Workflow } from '../entities';

@Injectable()
export class ExecutionsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Execution) private readonly executions: Repository<Execution>,
    @InjectRepository(StepRun) private readonly stepRuns: Repository<StepRun>,
  ) {}

  /** Створює execution і job в одній транзакції. */
  async enqueue(
    workflow: Workflow,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
  ): Promise<Execution> {
    return this.ds.transaction(async (em) => {
      const execution = await em.save(
        em.create(Execution, { tenantId: workflow.tenantId, workflowId: workflow.id, input, trigger }),
      );
      await em.save(em.create(Job, { tenantId: workflow.tenantId, executionId: execution.id }));
      return execution;
    });
  }

  list(tenantId: string, limit = 50): Promise<Execution[]> {
    return this.executions.find({ where: { tenantId }, order: { createdAt: 'DESC' }, take: Math.min(limit, 200) });
  }

  async get(id: string): Promise<Execution & { steps: StepRun[] }> {
    const execution = await this.executions.findOne({ where: { id } });
    if (!execution) throw new NotFoundException('Execution не знайдено');
    const steps = await this.stepRuns.find({ where: { executionId: id }, order: { stepIndex: 'ASC', startedAt: 'ASC' } });
    return { ...execution, steps };
  }
}
