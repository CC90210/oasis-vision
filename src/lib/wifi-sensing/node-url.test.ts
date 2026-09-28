import { describe, expect, it } from 'vitest';
import { DEFAULT_NODE_URL, ticketUrlFor, toSensingSocketUrl, withTicket } from './node-url';

describe('toSensingSocketUrl', () => {
  it.each([
    ['192.168.1.20:8765', 'ws://192.168.1.20:8765/ws/sensing'],
    ['http://192.168.1.20:3000', 'ws://192.168.1.20:3000/ws/sensing'],
    ['https://sensor.local', 'wss://sensor.local/ws/sensing'],
    ['ws://127.0.0.1:8765/ws/sensing', 'ws://127.0.0.1:8765/ws/sensing'],
    ['  ws://pi.local:8765  ', 'ws://pi.local:8765/ws/sensing'],
  ])('%s -> %s', (input, expected) => {
    expect(toSensingSocketUrl(input)).toBe(expected);
  });

  it('keeps an explicit path the operator chose', () => {
    expect(toSensingSocketUrl('ws://pi.local:8765/custom')).toBe('ws://pi.local:8765/custom');
  });

  it('rejects what is not a socket address', () => {
    expect(toSensingSocketUrl('')).toBeNull();
    expect(toSensingSocketUrl('ftp://x')).toBeNull();
    expect(toSensingSocketUrl('javascript:alert(1)')).toBeNull();
    expect(toSensingSocketUrl('ws://')).toBeNull();
  });

  it('accepts its own default', () => {
    expect(toSensingSocketUrl(DEFAULT_NODE_URL)).toBe(DEFAULT_NODE_URL);
  });
});

describe('ticket helpers', () => {
  it('asks the same host and port for the ticket, over HTTP(S)', () => {
    expect(ticketUrlFor('ws://pi.local:8765/ws/sensing')).toBe('http://pi.local:8765/api/v1/ws-ticket');
    expect(ticketUrlFor('wss://sensor.local/ws/sensing?x=1')).toBe('https://sensor.local/api/v1/ws-ticket');
  });

  it('appends the ticket as a query parameter, encoded', () => {
    expect(withTicket('ws://pi.local:8765/ws/sensing', 'a b&c')).toBe('ws://pi.local:8765/ws/sensing?ticket=a+b%26c');
  });
});
