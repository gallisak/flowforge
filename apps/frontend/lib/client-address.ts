import { isIP } from 'net';

export const CLIENT_ADDRESS_HEADER = 'x-client-address';
export const CLIENT_ADDRESS_SECRET_HEADER = 'x-client-address-secret';

function trustedProxyHops(): number {
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? '0');
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

export function clientAddressHeaders(incoming: Headers): Record<string, string> {
  const secret = process.env.CLIENT_ADDRESS_SECRET ?? '';
  if (!secret) return {};
  const chain = (incoming.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const address = chain[Math.max(0, chain.length - 1 - trustedProxyHops())];
  if (!address || isIP(address) === 0) return {};
  return { [CLIENT_ADDRESS_HEADER]: address, [CLIENT_ADDRESS_SECRET_HEADER]: secret };
}
