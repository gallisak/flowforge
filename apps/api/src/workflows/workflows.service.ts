import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { TenantDb } from '../db/tenant-db.service';
import { Workflow, WorkflowVersion } from '../entities';
import { validateSteps } from './definition';
import { validateSchedule } from './schedule';
import { CreateWorkflowDto, UpdateWorkflowDto } from './workflow.dto';

@Injectable()
export class WorkflowsService {
  constructor(private readonly db: TenantDb) {}

  list(tenantId: string): Promise<Workflow[]> {
    return this.db.run(tenantId, (em) => em.find(Workflow, { where: { tenantId }, order: { createdAt: 'DESC' } }));
  }

  get(tenantId: string, id: string): Promise<Workflow> {
    return this.db.run(tenantId, (em) => this.findOwned(em, tenantId, id));
  }

  create(tenantId: string, input: CreateWorkflowDto): Promise<Workflow> {
    const steps = validateSteps(input.steps);
    validateSchedule(input.cron ?? null, input.timezone ?? 'UTC');
    return this.db.run(tenantId, async (em) => {
      const wf = await em.save(
        em.create(Workflow, {
          tenantId,
          name: input.name,
          steps,
          cron: input.cron ?? null,
          timezone: input.timezone ?? 'UTC',
          enabled: input.enabled ?? true,
        }),
      );
      await this.recordVersion(em, wf);
      return wf;
    });
  }

  update(tenantId: string, id: string, input: UpdateWorkflowDto): Promise<Workflow> {
    return this.db.run(tenantId, async (em) => {
      const wf = await this.findOwned(em, tenantId, id, true);
      validateSchedule(input.cron === undefined ? wf.cron : input.cron, input.timezone ?? wf.timezone);
      if (input.name !== undefined) wf.name = input.name;
      if (input.steps !== undefined) {
        wf.steps = validateSteps(input.steps);
        wf.version += 1;
      }
      if (input.cron !== undefined) wf.cron = input.cron;
      if (input.timezone !== undefined) wf.timezone = input.timezone;
      if (input.enabled !== undefined) wf.enabled = input.enabled;
      const saved = await em.save(wf);
      if (input.steps !== undefined) await this.recordVersion(em, saved);
      return saved;
    });
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
