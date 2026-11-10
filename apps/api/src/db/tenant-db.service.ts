import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthenticatedTenant {
  id: string;
  name: string;
}

export interface WebhookTarget {
  tenantId: string;
}

export interface ScheduledWorkflow {
  id: string;
  tenantId: string;
  cron: string;
  timezone: string;
}

export interface ReadyJob {
  id: string;
  tenantId: string;
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

  listScheduledWorkflows(): Promise<ScheduledWorkflow[]> {
    return this.dataSource.query('SELECT * FROM list_scheduled_workflows()');
  }

  async nextReadyJob(): Promise<ReadyJob | null> {
    const rows: ReadyJob[] = await this.dataSource.query('SELECT * FROM next_ready_job()');
    return rows[0] ?? null;
  }
}
