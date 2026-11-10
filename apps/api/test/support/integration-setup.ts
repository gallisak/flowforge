jest.setTimeout(60_000);

process.env.SCHEDULER_TICK_MS ??= String(60 * 60 * 1000);
