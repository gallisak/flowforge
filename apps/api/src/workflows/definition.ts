import { BadRequestException } from '@nestjs/common';
import { fixedOriginOf } from '../engine/template';
import { StepDefinition } from '../entities';

const STEP_TYPES = ['http', 'transform', 'log', 'delay'] as const;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export const STEP_LIMITS = {
  steps: 50,
  urlLength: 2048,
  headers: 20,
  headerNameLength: 100,
  headerValueLength: 1024,
  bodyLength: 64 * 1024,
  exprLength: 4 * 1024,
  messageLength: 2 * 1024,
  delayMs: 3_600_000,
} as const;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new BadRequestException(message);
}

function validateHttpStep(step: Record<string, unknown>, at: string): void {
  if (typeof step.url !== 'string') invalid(`${at}.url is required`);
  if (step.url.length > STEP_LIMITS.urlLength) invalid(`${at}.url must be at most ${STEP_LIMITS.urlLength} characters`);
  if (!fixedOriginOf(step.url)) {
    invalid(`${at}.url must start with a fixed http or https origin; placeholders are allowed only in the path, query or fragment`);
  }
  if (step.method !== undefined && !HTTP_METHODS.includes(step.method as (typeof HTTP_METHODS)[number])) {
    invalid(`${at}.method must be one of ${HTTP_METHODS.join(', ')}`);
  }
  if (step.headers !== undefined) {
    if (!isPlainObject(step.headers)) invalid(`${at}.headers must be an object`);
    const entries = Object.entries(step.headers);
    if (entries.length > STEP_LIMITS.headers) invalid(`${at}.headers must have at most ${STEP_LIMITS.headers} entries`);
    for (const [name, value] of entries) {
      if (!HEADER_NAME.test(name) || name.length > STEP_LIMITS.headerNameLength) invalid(`${at}.headers has an invalid name`);
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) invalid(`${at}.headers must not set ${name.toLowerCase()}`);
      if (typeof value !== 'string' || value.length > STEP_LIMITS.headerValueLength || /[\r\n]/.test(value)) {
        invalid(`${at}.headers.${name} must be a single-line string of at most ${STEP_LIMITS.headerValueLength} characters`);
      }
    }
  }
  if (step.body !== undefined) {
    if (typeof step.body !== 'string') invalid(`${at}.body must be a string`);
    if (step.body.length > STEP_LIMITS.bodyLength) invalid(`${at}.body must be at most ${STEP_LIMITS.bodyLength} characters`);
  }
}

export function validateSteps(raw: unknown): StepDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > STEP_LIMITS.steps) {
    invalid(`steps must be an array of 1 to ${STEP_LIMITS.steps} items`);
  }
  const seen = new Set<string>();
  raw.forEach((s, i) => {
    const at = `steps[${i}]`;
    if (!isPlainObject(s)) invalid(`${at} must be an object`);
    const step = s;
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(step.id)) invalid(`${at}.id is invalid`);
    if (seen.has(step.id)) invalid(`Duplicate step id: ${step.id}`);
    seen.add(step.id);
    if (!STEP_TYPES.includes(step.type as (typeof STEP_TYPES)[number])) invalid(`${at}.type is unknown`);

    if (step.type === 'http') validateHttpStep(step, at);
    if (step.type === 'transform') {
      if (typeof step.expr !== 'string') invalid(`${at}.expr is required`);
      if (step.expr.length > STEP_LIMITS.exprLength) invalid(`${at}.expr must be at most ${STEP_LIMITS.exprLength} characters`);
    }
    if (step.type === 'log') {
      if (typeof step.message !== 'string') invalid(`${at}.message is required`);
      if (step.message.length > STEP_LIMITS.messageLength) {
        invalid(`${at}.message must be at most ${STEP_LIMITS.messageLength} characters`);
      }
    }
    if (step.type === 'delay' && !(typeof step.ms === 'number' && step.ms >= 0 && step.ms <= STEP_LIMITS.delayMs)) {
      invalid(`${at}.ms must be a number in 0..${STEP_LIMITS.delayMs}`);
    }
  });
  return raw as StepDefinition[];
}
