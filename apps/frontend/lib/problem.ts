import { STATUS_CODES } from 'http';

export interface ProblemBody {
  statusCode: number;
  message: string;
  error: string;
}

export function problemBody(status: number, message: string): ProblemBody {
  return { statusCode: status, message, error: STATUS_CODES[status] ?? 'Error' };
}
