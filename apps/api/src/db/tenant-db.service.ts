import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Job } from '../entities';
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

  listDueSchedules(now: Date): Promise<DueSchedule[]> {
    return this.dataSource.query('SELECT * FROM list_due_schedules($1)', [now]);
  }

  async hitRateLimit(tenantId: string, defaultLimit: number): Promise<RateLimitHit> {
    const [row]: RateLimitHit[] = await this.dataSource.query('SELECT * FROM rate_limit_hit($1, $2)', [tenantId, defaultLimit]);
    return row;
  }

  reapExpiredJobs(): Promise<ReapedJob[]> {
    return this.dataSource.query('SELECT * FROM reap_expired_jobs()');
  }

  async claimJob(workerId: string, leaseSeconds: number, defaultMaxRunning: number): Promise<Job | null> {
    const rows: Job[] = await this.dataSource.query('SELECT * FROM claim_job($1, $2, $3)', [workerId, leaseSeconds, defaultMaxRunning]);
    return rows[0] ?? null;
  }
}
