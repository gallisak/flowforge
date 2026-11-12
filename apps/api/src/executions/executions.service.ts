import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { QUEUE_LIMITS, QueueLimits } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Execution, ExecutionStatus, Job, StepRun, Tenant, Workflow } from '../entities';
import { decodeCursor, encodeCursor } from './execution-cursor';
import { TooManyRequestsException } from '../limits/too-many-requests';
import { currentCorrelationId } from '../observability/log-context';

const QUEUE_FULL_RETRY_AFTER_SECONDS = 30;
const SUMMARY_COLUMNS = [
  'id',
  'tenantId',
  'workflowId',
  'workflowVersion',
  'status',
  'error',
  'trigger',
  'triggerKey',
  'correlationId',
  'createdAt',
  'finishedAt',
] as const;

export type ExecutionSummary = Pick<Execution, (typeof SUMMARY_COLUMNS)[number]>;
export const OUTPUT_PREVIEW_MAX_BYTES = 8 * 1024;
export type StepRunDetail = StepRun & { outputTruncated: boolean };
export type ExecutionDetail = Execution & { outputTruncated: boolean; steps: StepRunDetail[] };

function previewOf(alias: string): string {
  return `CASE WHEN ${alias}."outputBytes" <= $3 THEN ${alias}."output" END AS "output", COALESCE(${alias}."outputBytes" > $3, false) AS "outputTruncated"`;
}
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface ExecutionListFilter {
  limit?: number;
  status?: ExecutionStatus;
  workflowId?: string;
  cursor?: string;
}

export interface ExecutionPage {
  items: ExecutionSummary[];
  nextCursor: string | null;
}

export interface EnqueuedExecution {
  execution: Execution;
  created: boolean;
}

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);

  constructor(
    private readonly db: TenantDb,
    @Inject(QUEUE_LIMITS) private readonly limits: QueueLimits,
  ) {}

  enqueue(
    workflow: Pick<Workflow, 'id' | 'tenantId'>,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
    triggerKey: string | null = null,
  ): Promise<Execution> {
    return this.db.run(workflow.tenantId, async (em) => (await this.enqueueWithin(em, workflow, input, trigger, triggerKey)).execution);
  }

  async enqueueWithin(
    em: EntityManager,
    workflow: Pick<Workflow, 'id' | 'tenantId'>,
    input: Record<string, unknown>,
    trigger: Execution['trigger'],
    triggerKey: string | null = null,
  ): Promise<EnqueuedExecution> {
    const current = await em.findOne(Workflow, {
      where: { id: workflow.id, tenantId: workflow.tenantId },
      lock: { mode: 'pessimistic_read' },
    });
    if (!current) throw new NotFoundException('Workflow not found');
    if (triggerKey) {
      const existing = await em.findOne(Execution, { where: { tenantId: workflow.tenantId, triggerKey } });
      if (existing) return { execution: existing, created: false };
    }
    const tenant = await em.findOneOrFail(Tenant, { where: { id: workflow.tenantId } });
    const maxQueued = tenant.maxQueuedJobs ?? this.limits.tenantMaxQueuedJobs;
    const [{ queued }]: Array<{ queued: number }> = await em.query(
      `SELECT count(*)::int AS queued
         FROM (SELECT 1 FROM "jobs" WHERE "tenantId" = $1 AND "status" = 'queued' AND "runAt" <= now() LIMIT $2) q`,
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
        correlationId: currentCorrelationId() ?? randomUUID(),
      })
      .setParameter('input', JSON.stringify(input))
      .orIgnore()
      .returning('id')
      .execute();
    const id: string | undefined = inserted.raw[0]?.id;
    if (!id) {
      if (!triggerKey) throw new Error('the execution was not inserted');
      return { execution: await em.findOneOrFail(Execution, { where: { tenantId: workflow.tenantId, triggerKey } }), created: false };
    }
    await em.save(em.create(Job, { tenantId: workflow.tenantId, executionId: id, maxAttempts: this.limits.jobMaxAttempts }));
    this.logger.log({ msg: 'execution created', executionId: id, workflowId: workflow.id, tenantId: workflow.tenantId, trigger });
    return { execution: await em.findOneOrFail(Execution, { where: { id } }), created: true };
  }

  list(tenantId: string, filter: ExecutionListFilter = {}): Promise<ExecutionPage> {
    const limit = Math.min(filter.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const after = filter.cursor ? decodeCursor(filter.cursor) : null;
    return this.db.run(tenantId, async (em) => {
      const query = em
        .createQueryBuilder(Execution, 'e')
        .select(SUMMARY_COLUMNS.map((column) => `e.${column}`))
        .addSelect('e."createdAt"::text', 'cursor_created_at')
        .where('e."tenantId" = :tenantId', { tenantId })
        .orderBy('e."createdAt"', 'DESC')
        .addOrderBy('e."id"', 'DESC')
        .limit(limit + 1);
      if (filter.status) query.andWhere('e."status" = :status', { status: filter.status });
      if (filter.workflowId) query.andWhere('e."workflowId" = :workflowId', { workflowId: filter.workflowId });
      if (after) {
        query.andWhere('(e."createdAt", e."id") < (CAST(:afterCreatedAt AS timestamp), CAST(:afterId AS uuid))', {
          afterCreatedAt: after.createdAt,
          afterId: after.id,
        });
      }
      const { entities, raw } = await query.getRawAndEntities<{ cursor_created_at: string }>();
      const items = entities.slice(0, limit);
      const last = items[items.length - 1];
      const nextCursor =
        entities.length > limit && last ? encodeCursor({ createdAt: raw[items.length - 1].cursor_created_at, id: last.id }) : null;
      return { items, nextCursor };
    });
  }

  get(tenantId: string, id: string): Promise<ExecutionDetail> {
    return this.db.run(tenantId, async (em) => {
      const [execution]: Array<Omit<ExecutionDetail, 'steps'>> = await em.query(
        `SELECT e."id", e."tenantId", e."workflowId", e."workflowVersion", e."status", e."input", ${previewOf('e')},
                e."error", e."trigger", e."triggerKey", e."correlationId", e."createdAt", e."finishedAt"
           FROM "executions" e
          WHERE e."id" = $1 AND e."tenantId" = $2`,
        [id, tenantId, OUTPUT_PREVIEW_MAX_BYTES],
      );
      if (!execution) throw new NotFoundException('Execution not found');
      const steps: StepRunDetail[] = await em.query(
        `SELECT s."id", s."tenantId", s."executionId", s."stepIndex", s."stepId", s."status", s."attempts", s."idempotencyKey",
                ${previewOf('s')}, s."error", s."startedAt", s."wakeAt", s."finishedAt"
           FROM "step_runs" s
          WHERE s."executionId" = $1 AND s."tenantId" = $2
          ORDER BY s."stepIndex" ASC, s."startedAt" ASC`,
        [id, tenantId, OUTPUT_PREVIEW_MAX_BYTES],
      );
      return { ...execution, steps };
    });
  }

  watch(tenantId: string, id: string, seconds: number): Promise<void> {
    return this.db.run(tenantId, async (em) => {
      await em.query('SELECT watch_execution($1, $2)', [id, seconds]);
    });
  }

  outputOf(tenantId: string, id: string, stepIndex?: number): Promise<string> {
    return this.db.run(tenantId, async (em) => {
      const rows: Array<{ output: string | null }> =
        stepIndex === undefined
          ? await em.query(`SELECT "output"::text AS "output" FROM "executions" WHERE "id" = $1 AND "tenantId" = $2`, [id, tenantId])
          : await em.query(
              `SELECT "output"::text AS "output" FROM "step_runs" WHERE "executionId" = $1 AND "tenantId" = $2 AND "stepIndex" = $3`,
              [id, tenantId, stepIndex],
            );
      if (rows.length === 0) throw new NotFoundException(stepIndex === undefined ? 'Execution not found' : 'Step run not found');
      return rows[0].output ?? 'null';
    });
  }
}
