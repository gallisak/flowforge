import { ForbiddenException, Inject, Injectable, NotFoundException, PreconditionFailedException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { WORKFLOW_LIMITS, WorkflowLimits } from '../config/config';
import { TenantDb } from '../db/tenant-db.service';
import { Workflow, WorkflowVersion } from '../entities';
import { decodeCursor, encodeCursor } from '../executions/execution-cursor';
import { nextOccurrence } from '../scheduler/cron-schedule';
import { validateSteps } from './definition';
import { validateSchedule } from './schedule';
import { matchesPrecondition, WORKFLOW_CHANGED } from './workflow-precondition';
import { CreateWorkflowDto, UpdateWorkflowDto } from './workflow.dto';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const SUMMARY_COLUMNS = ['id', 'tenantId', 'name', 'enabled', 'cron', 'timezone', 'missedRunPolicy', 'nextRunAt', 'version', 'createdAt'] as const;

export type WorkflowSummary = Pick<Workflow, (typeof SUMMARY_COLUMNS)[number]>;

export interface WorkflowListFilter {
  limit?: number;
  cursor?: string;
}

export interface WorkflowPage {
  items: WorkflowSummary[];
  nextCursor: string | null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

function firstRunAt(cron: string | null, timezone: string, enabled: boolean): Date | null {
  return enabled && cron !== null ? nextOccurrence({ cron, timezone }, new Date()) : null;
}

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly db: TenantDb,
    @Inject(WORKFLOW_LIMITS) private readonly limits: WorkflowLimits,
  ) {}

  list(tenantId: string, filter: WorkflowListFilter = {}): Promise<WorkflowPage> {
    const limit = Math.min(filter.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const after = filter.cursor ? decodeCursor(filter.cursor) : null;
    return this.db.run(tenantId, async (em) => {
      const query = em
        .createQueryBuilder(Workflow, 'w')
        .select(SUMMARY_COLUMNS.map((column) => `w.${column}`))
        .addSelect('w."createdAt"::text', 'cursor_created_at')
        .where('w."tenantId" = :tenantId', { tenantId })
        .orderBy('w."createdAt"', 'DESC')
        .addOrderBy('w."id"', 'DESC')
        .limit(limit + 1);
      if (after) {
        query.andWhere('(w."createdAt", w."id") < (CAST(:afterCreatedAt AS timestamp), CAST(:afterId AS uuid))', {
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

  get(tenantId: string, id: string): Promise<Workflow> {
    return this.db.run(tenantId, (em) => this.findOwned(em, tenantId, id));
  }

  create(tenantId: string, input: CreateWorkflowDto): Promise<Workflow> {
    const steps = validateSteps(input.steps);
    return this.db.run(tenantId, async (em) => {
      await this.assertBelowWorkflowLimit(em, tenantId);
      validateSchedule(input.cron ?? null, input.timezone ?? 'UTC');
      const wf = await em.save(
        em.create(Workflow, {
          tenantId,
          name: input.name,
          steps,
          cron: input.cron ?? null,
          timezone: input.timezone ?? 'UTC',
          enabled: input.enabled ?? true,
          missedRunPolicy: input.missedRunPolicy ?? 'once',
          nextRunAt: firstRunAt(input.cron ?? null, input.timezone ?? 'UTC', input.enabled ?? true),
        }),
      );
      await this.recordVersion(em, wf);
      delete wf.scheduleRetryAt;
      return wf;
    });
  }

  update(tenantId: string, id: string, input: UpdateWorkflowDto, ifMatch?: string): Promise<Workflow> {
    return this.db.run(tenantId, async (em) => {
      const wf = await this.findOwned(em, tenantId, id, true);
      if (ifMatch !== undefined && !matchesPrecondition(ifMatch, wf.version)) throw new PreconditionFailedException(WORKFLOW_CHANGED);
      if (input.cron !== undefined || input.timezone !== undefined) {
        validateSchedule(input.cron === undefined ? wf.cron : input.cron, input.timezone ?? wf.timezone);
      }
      if (input.name !== undefined) wf.name = input.name;
      const steps = input.steps === undefined ? undefined : validateSteps(input.steps);
      const stepsChanged = steps !== undefined && canonicalJson(steps) !== canonicalJson(wf.steps);
      if (steps !== undefined && stepsChanged) {
        wf.steps = steps;
        wf.version += 1;
      }
      const scheduleBefore = [wf.cron, wf.timezone, wf.enabled].join('|');
      if (input.cron !== undefined) wf.cron = input.cron;
      if (input.timezone !== undefined) wf.timezone = input.timezone;
      if (input.enabled !== undefined) wf.enabled = input.enabled;
      if (input.missedRunPolicy !== undefined) wf.missedRunPolicy = input.missedRunPolicy;
      if ([wf.cron, wf.timezone, wf.enabled].join('|') !== scheduleBefore) {
        wf.nextRunAt = firstRunAt(wf.cron, wf.timezone, wf.enabled);
        wf.scheduleRetryAt = null;
      }
      const saved = await em.save(wf);
      delete saved.scheduleRetryAt;
      if (stepsChanged) await this.recordVersion(em, saved);
      return saved;
    });
  }

  private async assertBelowWorkflowLimit(em: EntityManager, tenantId: string): Promise<void> {
    const max = this.limits.tenantMaxWorkflows;
    await em.query(`SELECT pg_advisory_xact_lock(hashtextextended('workflows:' || $1, 0))`, [tenantId]);
    const [{ workflows }]: Array<{ workflows: number }> = await em.query(
      `SELECT count(*)::int AS workflows FROM (SELECT 1 FROM "workflows" WHERE "tenantId" = $1 LIMIT $2) w`,
      [tenantId, max],
    );
    if (workflows >= max) throw new ForbiddenException(`Workflow limit of ${max} reached; delete workflows you no longer need`);
  }

  private async recordVersion(em: EntityManager, wf: Workflow): Promise<void> {
    await em.insert(WorkflowVersion, { tenantId: wf.tenantId, workflowId: wf.id, version: wf.version, steps: wf.steps });
  }

  remove(tenantId: string, id: string): Promise<void> {
    return this.db.run(tenantId, async (em) => {
      const wf = await this.findOwned(em, tenantId, id);
      await em.remove(wf);
    });
  }

  private async findOwned(em: EntityManager, tenantId: string, id: string, forUpdate = false): Promise<Workflow> {
    const wf = await em.findOne(Workflow, {
      where: { id, tenantId },
      ...(forUpdate ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!wf) throw new NotFoundException('Workflow not found');
    return wf;
  }
}
