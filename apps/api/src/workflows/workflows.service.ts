import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workflow } from '../entities';
import { validateSteps } from './definition';

export interface WorkflowInput {
  name: string;
  steps: unknown;
  cron?: string | null;
  timezone?: string;
  enabled?: boolean;
}

@Injectable()
export class WorkflowsService {
  constructor(@InjectRepository(Workflow) private readonly workflows: Repository<Workflow>) {}

  list(tenantId: string): Promise<Workflow[]> {
    return this.workflows.find({ where: { tenantId }, order: { createdAt: 'DESC' } });
  }

  async get(tenantId: string, id: string): Promise<Workflow> {
    const wf = await this.workflows.findOne({ where: { id, tenantId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    return wf;
  }

  create(tenantId: string, input: WorkflowInput): Promise<Workflow> {
    return this.workflows.save(
      this.workflows.create({
        tenantId,
        name: input.name,
        steps: validateSteps(input.steps),
        cron: input.cron ?? null,
        timezone: input.timezone ?? 'UTC',
        enabled: input.enabled ?? true,
      }),
    );
  }

  async update(tenantId: string, id: string, input: Partial<WorkflowInput>): Promise<Workflow> {
    const wf = await this.get(tenantId, id);
    if (input.name !== undefined) wf.name = input.name;
    if (input.steps !== undefined) {
      wf.steps = validateSteps(input.steps);
      wf.version += 1;
    }
    if (input.cron !== undefined) wf.cron = input.cron;
    if (input.timezone !== undefined) wf.timezone = input.timezone;
    if (input.enabled !== undefined) wf.enabled = input.enabled;
    return this.workflows.save(wf);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const wf = await this.get(tenantId, id);
    await this.workflows.remove(wf);
  }
}
