import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../db/tenant-db.service';
import { Execution, Job, StepRun, Workflow } from '../entities';

@Injectable()
export class ExecutionsService {
  constructor(private readonly db: TenantDb) {}

  enqueue(
    workflow: Pick<Workflow, 'id' | 'tenantId'>,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
  ): Promise<Execution> {
    return this.db.run(workflow.tenantId, async (em) => {
      const execution = await em.save(
        em.create(Execution, { tenantId: workflow.tenantId, workflowId: workflow.id, input, trigger }),
      );
      await em.save(em.create(Job, { tenantId: workflow.tenantId, executionId: execution.id }));
      return execution;
    });
  }

  list(tenantId: string, limit = 50): Promise<Execution[]> {
    return this.db.run(tenantId, (em) =>
      em.find(Execution, { where: { tenantId }, order: { createdAt: 'DESC' }, take: Math.min(limit, 200) }),
    );
  }

  get(tenantId: string, id: string): Promise<Execution & { steps: StepRun[] }> {
    return this.db.run(tenantId, async (em) => {
      const execution = await em.findOne(Execution, { where: { id, tenantId } });
      if (!execution) throw new NotFoundException('Execution not found');
      const steps = await em.find(StepRun, {
        where: { executionId: id },
        order: { stepIndex: 'ASC', startedAt: 'ASC' },
      });
      return { ...execution, steps };
    });
  }
}
