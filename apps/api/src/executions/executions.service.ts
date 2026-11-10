import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { API_CONFIG, ApiConfig } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Execution, Job, StepRun, Tenant, Workflow } from '../entities';
import { TooManyRequestsException } from '../limits/too-many-requests';

const QUEUE_FULL_RETRY_AFTER_SECONDS = 30;

@Injectable()
export class ExecutionsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  enqueue(
    workflow: Pick<Workflow, 'id' | 'tenantId'>,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
    triggerKey: string | null = null,
  ): Promise<Execution> {
    return this.db.run(workflow.tenantId, async (em) => {
      const current = await em.findOne(Workflow, {
        where: { id: workflow.id, tenantId: workflow.tenantId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!current) throw new NotFoundException('Workflow not found');
      if (triggerKey) {
        const existing = await em.findOne(Execution, { where: { tenantId: workflow.tenantId, triggerKey } });
        if (existing) return existing;
      }
      const tenant = await em.findOneOrFail(Tenant, { where: { id: workflow.tenantId } });
      const maxQueued = tenant.maxQueuedJobs ?? this.config.tenantMaxQueuedJobs;
      const [{ queued }]: Array<{ queued: number }> = await em.query(
        `SELECT count(*)::int AS queued FROM (SELECT 1 FROM "jobs" WHERE "tenantId" = $1 AND "status" = 'queued' LIMIT $2) q`,
        [workflow.tenantId, maxQueued],
      );
      if (queued >= maxQueued) {
        throw new TooManyRequestsException(`Queue limit of ${maxQueued} jobs reached`, QUEUE_FULL_RETRY_AFTER_SECONDS);
      }
      const inserted = await em
        .createQueryBuilder()
        .insert()
        .into(Execution)
        .values({
          tenantId: workflow.tenantId,
          workflowId: workflow.id,
          workflowVersion: current.version,
          input: () => ':input',
          trigger,
          triggerKey,
        })
        .setParameter('input', JSON.stringify(input))
        .orIgnore()
        .returning('id')
        .execute();
      const id: string | undefined = inserted.raw[0]?.id;
      if (!id) {
        if (!triggerKey) throw new Error('the execution was not inserted');
        return em.findOneOrFail(Execution, { where: { tenantId: workflow.tenantId, triggerKey } });
      }
      await em.save(em.create(Job, { tenantId: workflow.tenantId, executionId: id }));
      return em.findOneOrFail(Execution, { where: { id } });
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
