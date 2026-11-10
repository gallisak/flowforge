import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const { apiKey } = (await req.json()) as { apiKey?: string };
  if (!apiKey) return NextResponse.json({ error: 'apiKey is required' }, { status: 400 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set('ff_api_key', apiKey, { httpOnly: true, sameSite: 'lax', path: '/' });
  return res;
}
