import { DataSource } from 'typeorm';
import { registerDatabaseGauges, registry } from '../src/observability/metrics';

describe('database gauges', () => {
  const failingDatabase = (query: () => Promise<unknown>) => ({ query }) as unknown as DataSource;

  it('keeps the rest of the metrics available when the database query fails', async () => {
    registerDatabaseGauges(failingDatabase(() => Promise.reject(new Error('database is down'))), 5, 50);

    await registry.metrics();
    const text = await registry.metrics();

    expect(text).toContain('flowforge_http_request_duration_seconds');
    expect(text).toMatch(/flowforge_metrics_collect_errors_total\{gauge="flowforge_queue_depth"\} [1-9]/);
  });

  it('answers a scrape in time when the database does not answer', async () => {
    registerDatabaseGauges(failingDatabase(() => new Promise(() => undefined)), 5, 50);
    const started = Date.now();

    await registry.metrics();
    const text = await registry.metrics();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(text).toMatch(/flowforge_metrics_collect_errors_total\{gauge="flowforge_outbox_backlog"\} [1-9]/);
  });
});
