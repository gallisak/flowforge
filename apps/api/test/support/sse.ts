import { IncomingHttpHeaders, request } from 'http';

export interface ServerSentEvent {
  event: string;
  data: string;
}

export interface EventStream {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly events: ServerSentEvent[];
  readonly ended: Promise<void>;
  close(): void;
}

export function openEventStream(url: string, headers: Record<string, string>): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const events: ServerSentEvent[] = [];
    let body = '';
    let buffer = '';
    let markEnded: () => void = () => undefined;
    const ended = new Promise<void>((done) => {
      markEnded = done;
    });
    const req = request(url, { headers: { accept: 'text/event-stream', ...headers } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split('\n');
          const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          if (event && data !== undefined) events.push({ event, data });
          boundary = buffer.indexOf('\n\n');
        }
      });
      res.on('end', markEnded);
      res.on('close', markEnded);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        get body() {
          return body;
        },
        events,
        ended,
        close: () => req.destroy(),
      });
    });
    req.on('error', (error) => {
      markEnded();
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}
