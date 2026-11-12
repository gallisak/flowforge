jest.setTimeout(60_000);

process.env.SCHEDULER_TICK_MS ??= '59000';
process.env.ADMIN_TOKEN ??= 'integration-test-admin-token';
process.env.WORKER_SHUTDOWN_GRACE_MS ??= '2000';
process.env.SSRF_ALLOWLIST ??= '127.0.0.1';
process.env.OUTBOX_POLL_INTERVAL_MS ??= '100';
process.env.OUTBOX_RETRY_BASE_MS ??= '50';
process.env.OUTBOX_RETRY_CAP_MS ??= '200';
process.env.METRICS_PORT ??= '0';
process.env.SCHEDULER_POSTPONE_MS ??= '5000';
