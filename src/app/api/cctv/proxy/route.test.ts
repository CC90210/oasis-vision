import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, proxyDeps, isAllowedTarget, readCapped, MAX_FRAME_BYTES } from './route';

const realFetch = proxyDeps.fetch;
const realValidate = proxyDeps.validateHost;

const SKYLINE = 'https://cdn.skylinewebcams.com/live1234.jpg';

function call(url: string) {
  return GET(new NextRequest(`http://localhost/api/cctv/proxy?url=${encodeURIComponent(url)}`));
}

function jpeg(bytes = 16, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg', ...headers } });
}

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  proxyDeps.fetch = fetchMock as unknown as typeof globalThis.fetch;
  proxyDeps.validateHost = vi.fn(async (host: string) =>
    host === '169.254.169.254' ? { ok: false, reason: 'IPv4 in reserved range' } : { ok: true, resolved: ['93.184.216.34'] },
  );
});

afterEach(() => {
  proxyDeps.fetch = realFetch;
  proxyDeps.validateHost = realValidate;
});

describe('allowlist is exact', () => {
  it('admits the measured camera hosts', () => {
    expect(isAllowedTarget(new URL(SKYLINE))).toBe(true);
    expect(isAllowedTarget(new URL('https://etraffic.dgt.es/x.jpg'))).toBe(true);
    expect(isAllowedTarget(new URL('https://cctv-ss05.thb.gov.tw/T1-1K/snapshot'))).toBe(true);
  });

  it('refuses suffix and lookalike hosts the old endsWith check admitted', () => {
    expect(isAllowedTarget(new URL('https://bucket.s3-eu-west-1.amazonaws.com/x.jpg'))).toBe(false);
    expect(isAllowedTarget(new URL('https://s3-eu-west-1.amazonaws.com/attacker-bucket/x.jpg'))).toBe(false);
    expect(isAllowedTarget(new URL('https://evil.cdn.skylinewebcams.com/x.jpg'))).toBe(false);
    expect(isAllowedTarget(new URL('https://cdn.skylinewebcams.com.evil.test/x.jpg'))).toBe(false);
  });

  it('refuses non-http schemes', () => {
    expect(isAllowedTarget(new URL('file://cdn.skylinewebcams.com/etc/passwd'))).toBe(false);
  });

  it('never fetches a host off the list', async () => {
    const res = await call('https://169.254.169.254/latest/meta-data/');
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('redirects', () => {
  it('refuses a redirect to a host off the allowlist, and never fetches it', async () => {
    fetchMock.mockResolvedValueOnce(redirect('http://169.254.169.254/latest/meta-data/'));
    const res = await call(SKYLINE);
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect to an allowed name that resolves to a reserved address', async () => {
    proxyDeps.validateHost = vi.fn(async (host: string) =>
      host === 'etraffic.dgt.es' ? { ok: false, reason: 'hostname resolves to reserved IPv4 10.0.0.5' } : { ok: true, resolved: ['93.184.216.34'] },
    );
    fetchMock.mockResolvedValueOnce(redirect('https://etraffic.dgt.es/x.jpg'));
    const res = await call(SKYLINE);
    expect(res.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows one redirect inside the allowlist, resolving a relative Location', async () => {
    fetchMock.mockResolvedValueOnce(redirect('/live9999.jpg', 301)).mockResolvedValueOnce(jpeg());
    const res = await call(SKYLINE);
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.skylinewebcams.com/live9999.jpg');
  });

  it('stops at the second redirect', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://cdn.skylinewebcams.com/a.jpg'))
      .mockResolvedValueOnce(redirect('https://cdn.skylinewebcams.com/b.jpg'));
    const res = await call(SKYLINE);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/one hop is the limit/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks fetch not to follow redirects itself', async () => {
    fetchMock.mockResolvedValueOnce(jpeg());
    await call(SKYLINE);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
  });
});

describe('what gets relayed', () => {
  it('relays an image with nosniff', async () => {
    fetchMock.mockResolvedValueOnce(jpeg(32));
    const res = await call(SKYLINE);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await res.arrayBuffer()).byteLength).toBe(32);
  });

  it('refuses HTML, so an upstream page is never served from our origin', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<script>alert(1)</script>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const res = await call(SKYLINE);
    expect(res.status).toBe(502);
  });

  it('refuses SVG, which can carry script', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } }));
    expect((await call(SKYLINE)).status).toBe(502);
  });

  it('refuses a body over the cap even when the upstream declares no length', async () => {
    const big = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(MAX_FRAME_BYTES));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(big, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    expect((await call(SKYLINE)).status).toBe(502);
  });

  it('refuses a declared length over the cap without reading it', async () => {
    const res = jpeg(4, { 'content-length': String(MAX_FRAME_BYTES + 1) });
    expect(await readCapped(res, MAX_FRAME_BYTES)).toBeNull();
  });

  it('omits the Referer for Taiwan Highway Bureau servers and sends it elsewhere', async () => {
    fetchMock.mockImplementation(async () => jpeg());
    await call('https://cctv-ss03.thb.gov.tw/T1-1K/snapshot');
    await call(SKYLINE);
    expect(fetchMock.mock.calls[0][1].headers.Referer).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].headers.Referer).toBe('https://cdn.skylinewebcams.com/');
  });
});
