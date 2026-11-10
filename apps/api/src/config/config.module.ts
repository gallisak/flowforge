import { Global, Module } from '@nestjs/common';
import { API_CONFIG, loadApiConfig, loadWorkerConfig, WORKER_CONFIG } from './config';

@Global()
@Module({
  providers: [{ provide: API_CONFIG, useFactory: () => loadApiConfig() }],
  exports: [API_CONFIG],
})
export class ApiConfigModule {}

@Global()
@Module({
  providers: [{ provide: WORKER_CONFIG, useFactory: () => loadWorkerConfig() }],
  exports: [WORKER_CONFIG],
})
export class WorkerConfigModule {}
