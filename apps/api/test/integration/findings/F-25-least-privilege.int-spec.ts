import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { createTestApp } from '../../support/app';
import { useIntegrationContext } from '../../support/context';
import { spawnAppProcess } from '../../support/process';

describe('F-25 the API runs with least privilege and refuses insecure configuration', () => {
  const ctx = useIntegrationContext();
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('connects to Postgres as a role that is not a superuser and cannot bypass row level security', async () => {
    const [role] = await app
      .get(DataSource)
      .query('SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user');

    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
  });

  it('cannot change the schema with the application role', async () => {
    await expect(app.get(DataSource).query('CREATE TABLE least_privilege_probe (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('refuses to start in production with a placeholder admin token', async () => {
    const api = spawnAppProcess('main', {
      NODE_ENV: 'production',
      PORT: '0',
      DATABASE_URL: ctx.db.url,
      ADMIN_TOKEN: 'change-me-admin',
    });
    try {
      const exit = await api.waitForExit(15_000);
      expect(exit.code).not.toBe(0);
      expect(api.output()).toMatch(/ADMIN_TOKEN/);
      expect(api.output()).not.toMatch(/change-me-admin/);
    } finally {
      await api.kill();
    }
  });

  it('starts in production with a strong admin token', async () => {
    const api = spawnAppProcess('main', {
      NODE_ENV: 'production',
      PORT: '0',
      DATABASE_URL: ctx.db.url,
      ADMIN_TOKEN: randomBytes(32).toString('hex'),
    });
    try {
      await api.waitForOutput(/listening on/);
    } finally {
      await api.kill();
    }
  });
});
