import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  const key = req.cookies.get('ff_api_key')?.value ?? '';
  const res = await fetch(`${API_URL}/${params.path.join('/')}`, { headers: { 'x-api-key': key }, cache: 'no-store' });
  return new NextResponse(await res.text(), { status: res.status, headers: { 'content-type': 'application/json' } });
}
