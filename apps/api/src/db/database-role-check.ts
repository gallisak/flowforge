import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

interface RolePrivileges {
  role: string;
  superuser: boolean;
  bypassesRls: boolean;
  ownsTables: boolean;
}

export class PrivilegedDatabaseRoleError extends Error {}

@Injectable()
export class DatabaseRoleCheck implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    const [privileges]: RolePrivileges[] = await this.dataSource.query(`
      SELECT current_user AS "role",
             r."rolsuper" AS "superuser",
             r."rolbypassrls" AS "bypassesRls",
             EXISTS (
               SELECT 1 FROM pg_tables t
                WHERE t."schemaname" = 'public' AND pg_has_role(current_user, t."tableowner", 'MEMBER')
             ) AS "ownsTables"
        FROM pg_roles r
       WHERE r."rolname" = current_user
    `);
    if (privileges.superuser || privileges.bypassesRls || privileges.ownsTables) {
      await this.dataSource.destroy();
      throw new PrivilegedDatabaseRoleError(
        `DATABASE_URL role ${privileges.role} must not own the tables, be a superuser or bypass row level security; ` +
          'connect as the application role (flowforge_app)',
      );
    }
  }
}
