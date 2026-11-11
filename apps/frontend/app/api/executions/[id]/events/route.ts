import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  if (!UUID.test(params.id)) return NextResponse.json({ statusCode: 404, message: 'Execution not found' }, { status: 404 });
  const key = req.cookies.get('ff_api_key')?.value;
  if (!key) return NextResponse.json({ statusCode: 401, message: 'Connect with an API key first' }, { status: 401 });

  const upstream = await fetch(`${API_URL}/executions/${params.id}/events`, {
    headers: { 'x-api-key': key, accept: 'text/event-stream' },
    signal: req.signal,
    cache: 'no-store',
  });
  if (!upstream.ok || !upstream.body) {
    return new NextResponse(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  return new Response(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
