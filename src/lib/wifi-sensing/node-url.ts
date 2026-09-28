/**
 * Where a RuView sensing server lives, from whatever the operator typed.
 *
 * RuView serves `/health`, `/ws/sensing` and `/api/v1/ws-ticket` from one
 * port (8765 by default, 3000 in its Docker image), so the WebSocket URL is
 * also the base for the ticket request.
 */

export const DEFAULT_NODE_URL = 'ws://127.0.0.1:8765/ws/sensing';

/** Normalise `host:port`, `http(s)://…` or `ws(s)://…` to a `/ws/sensing` socket URL. */
export function toSensingSocketUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `ws://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  if (!u.hostname) return null;
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws/sensing';
  u.hash = '';
  return u.toString();
}

/** The HTTP endpoint that exchanges a bearer token for a single-use socket ticket (RuView ADR-272). */
export function ticketUrlFor(socketUrl: string): string {
  const u = new URL(socketUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/api/v1/ws-ticket';
  u.search = '';
  return u.toString();
}

export function withTicket(socketUrl: string, ticket: string): string {
  const u = new URL(socketUrl);
  u.searchParams.set('ticket', ticket);
  return u.toString();
}
