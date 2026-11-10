jest.setTimeout(60_000);

process.env.SCHEDULER_TICK_MS ??= String(60 * 60 * 1000);
process.env.ADMIN_TOKEN ??= 'integration-test-admin-token';
process.env.WORKER_SHUTDOWN_GRACE_MS ??= '2000';
process.env.SSRF_ALLOWLIST ??= '127.0.0.1';
