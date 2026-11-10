import { DataSource } from 'typeorm';
import { dataSourceOptions } from './data-source';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  throw new Error('MIGRATION_DATABASE_URL must be set to run TypeORM CLI commands');
}

export default new DataSource(dataSourceOptions(url));
