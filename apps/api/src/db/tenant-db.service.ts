import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Job, OutboxEvent } from '../entities';
import type { MissedRunPolicy } from '../scheduler/cron-schedule';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthenticatedTenant {
  id: string;
  name: string;
}

export interface DueSchedule {
  id: string;
  tenantId: string;
  cron: string;
  timezone: string;
  nextRunAt: Date;
  missedRunPolicy: MissedRunPolicy;
}

export interface RateLimitHit {
  limit: number;
  hits: number;
  resetAt: Date;
}

export interface ReapedJob {
  id: string;
  tenantId: string;
  executionId: string;
  status: 'queued' | 'dead';
  attempts: number;
}

@Injectable()
export class TenantDb {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  run<T>(tenantId: string, work: (manager: EntityManager) => Promise<T>): Promise<T> {
    if (!UUID.test(tenantId)) {
      return Promise.reject(new Error('Tenant context requires a tenant id'));
    }
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return work(manager);
    });
  }

  async authenticate(apiKeyHash: string): Promise<AuthenticatedTenant | null> {
    const rows: AuthenticatedTenant[] = await this.dataSource.query('SELECT * FROM auth_tenant($1)', [apiKeyHash]);
    return rows[0] ?? null;
  }

  async resolveWebhookTenant(workflowId: string): Promise<string | null> {
    const [row]: Array<{ tenantId: string | null }> = await this.dataSource.query(
      'SELECT resolve_webhook_tenant($1) AS "tenantId"',
      [workflowId],
    );
    return row?.tenantId ?? null;
  }

  claimDueSchedule<T>(
    now: Date,
    skip: readonly string[],
    work: (schedule: DueSchedule, manager: EntityManager) => Promise<T>,
  ): Promise<{ claimed: false } | { claimed: true; result: T }> {
    return this.dataSource.transaction(async (manager) => {
      const [schedule]: DueSchedule[] = await manager.query('SELECT * FROM claim_due_schedule($1, $2::uuid[])', [now, skip]);
      if (!schedule) return { claimed: false };
      await manager.query(`SELECT set_config('app.tenant_id', $1, true)`, [schedule.tenantId]);
      return { claimed: true, result: await work(schedule, manager) };
    });
  }

  async hitRateLimit(tenantId: string, defaultLimit: number): Promise<RateLimitHit> {
    const [row]: RateLimitHit[] = await this.dataSource.query('SELECT * FROM rate_limit_hit($1, $2)', [tenantId, defaultLimit]);
    return row;
  }

  reapExpiredJobs(): Promise<ReapedJob[]> {
    return this.dataSource.query('SELECT * FROM reap_expired_jobs()');
  }

  claimOutboxEvents(dispatcherId: string, leaseSeconds: number, limit: number): Promise<OutboxEvent[]> {
    return this.dataSource.query('SELECT * FROM claim_outbox_events($1, $2, $3)', [dispatcherId, leaseSeconds, limit]);
  }

  async claimJob(workerId: string, leaseSeconds: number, defaultMaxRunning: number): Promise<Job | null> {
    const rows: Job[] = await this.dataSource.query('SELECT * FROM claim_job($1, $2, $3)', [workerId, leaseSeconds, defaultMaxRunning]);
    return rows[0] ?? null;
  }
}
