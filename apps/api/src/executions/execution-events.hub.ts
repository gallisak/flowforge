import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { API_CONFIG, ApiConfig } from '../config/config';
import { EXECUTION_EVENTS_CHANNEL } from '../migrations/1794320900000-execution-change-notifications';

type Listener = () => void;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

@Injectable()
export class ExecutionEventsHub implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ExecutionEventsHub.name);
  private readonly listeners = new Map<string, Set<Listener>>();
  private client?: Client;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private stopped = false;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  onModuleInit(): void {
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.client?.end().catch(() => undefined);
  }

  get subscriberCount(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  subscribe(executionId: string, listener: Listener): () => void {
    const set = this.listeners.get(executionId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(executionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(executionId);
    };
  }

  private notify(executionId: string): void {
    for (const listener of [...(this.listeners.get(executionId) ?? [])]) listener();
  }

  private notifyEveryone(): void {
    for (const executionId of [...this.listeners.keys()]) this.notify(executionId);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({
      connectionString: this.config.databaseUrl,
      connectionTimeoutMillis: this.config.databaseTimeouts.connectTimeoutMs,
      keepAlive: true,
    });
    client.on('notification', (message) => {
      if (message.channel === EXECUTION_EVENTS_CHANNEL && message.payload) this.notify(message.payload);
    });
    client.on('error', (error) => this.reconnect(client, error));
    client.on('end', () => this.reconnect(client));
    try {
      await client.connect();
      await client.query(`LISTEN ${EXECUTION_EVENTS_CHANNEL}`);
      this.client = client;
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      this.notifyEveryone();
    } catch (error) {
      this.reconnect(client, error as Error);
    }
  }

  private reconnect(client: Client, error?: Error): void {
    if (this.stopped || this.reconnectTimer || (this.client && this.client !== client)) return;
    if (error) this.logger.warn(`execution event listener lost its connection: ${error.message}`);
    this.client = undefined;
    client.removeAllListeners();
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
  }
}
