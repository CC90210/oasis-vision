/**
 * Browser connection to a RuView sensing server (`/ws/sensing`).
 *
 * Reconnects with backoff while the view is open. When a token is set, each
 * attempt first exchanges it for a single-use ticket (RuView ADR-272) — a
 * ticket is valid once and for seconds, so one is never reused across
 * attempts. A 404 from the ticket endpoint means a server that predates
 * tickets, and the socket is opened without one.
 */
import { normalizeRuviewMessage } from '@/lib/wifi-sensing/frames';
import { ticketUrlFor, withTicket } from '@/lib/wifi-sensing/node-url';
import type { SensingFrame } from '@/lib/wifi-sensing/types';

export type NodeStatus = 'connecting' | 'live' | 'retrying' | 'stopped';

export interface NodeClientEvents {
  onStatus: (status: NodeStatus, detail: string | null) => void;
  onFrame: (frame: SensingFrame) => void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

export class RuviewNodeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string | null,
    private readonly events: NodeClientEvents,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    }
    this.events.onStatus('stopped', null);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.events.onStatus('connecting', this.url);
    let target = this.url;
    if (this.token) {
      try {
        const r = await fetch(ticketUrlFor(this.url), { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } });
        if (r.ok) {
          const body = (await r.json()) as { ticket?: string };
          if (body.ticket) target = withTicket(this.url, body.ticket);
        } else if (r.status !== 404) {
          this.retry(`ticket refused (HTTP ${r.status}) — check the token`);
          return;
        }
      } catch (e) {
        this.retry(`ticket request failed: ${(e as Error).message}`);
        return;
      }
    }
    if (this.stopped) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(target);
    } catch (e) {
      this.retry((e as Error).message);
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.attempt = 0;
      this.events.onStatus('live', this.url);
    };
    ws.onmessage = (evt) => {
      if (typeof evt.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(evt.data);
      } catch {
        return;
      }
      const frame = normalizeRuviewMessage(raw);
      if (frame) this.events.onFrame(frame);
    };
    ws.onclose = (evt) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.retry(opened ? `connection closed (${evt.code})` : 'no sensing server answered at this address');
    };
    ws.onerror = () => {
      /* onclose follows with the reason */
    };
  }

  private retry(reason: string): void {
    if (this.stopped) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.events.onStatus('retrying', `${reason} — retrying in ${Math.round(wait / 1000)} s`);
    this.timer = setTimeout(() => void this.connect(), wait);
  }
}
