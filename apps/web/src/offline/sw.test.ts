// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The service worker files are plain scripts in public/; the tests run them with a fake scope. */
const read = (name: string) => readFileSync(resolve(__dirname, '../../public', name), 'utf8');

interface Rules {
  CACHE: string;
  SHELL: string[];
  strategyFor(
    method: string,
    url: string,
    mode: string,
    destination: string,
    origin: string,
  ): 'shell' | 'hashed' | 'asset' | null;
}

const ORIGIN = 'https://ops.example.test';

function loadRules(): Rules {
  const scope: { swRules?: Rules } = {};
  runInNewContext(read('sw-rules.js'), { self: scope, URL });
  return scope.swRules as Rules;
}

describe('what the service worker may cache (BR-1, T-6)', () => {
  const rules = loadRules();
  const strategy = (method: string, path: string, mode = 'cors', destination = '') =>
    rules.strategyFor(method, `${ORIGIN}${path}`, mode, destination, ORIGIN);

  it('answers page navigations from the shell when offline', () => {
    expect(strategy('GET', '/dpr/reports/new', 'navigate', 'document')).toBe('shell');
  });

  it('caches built files by hash and other scripts and styles with a network-first rule', () => {
    expect(strategy('GET', '/assets/index-1a2b3c.js', 'cors', 'script')).toBe('hashed');
    expect(strategy('GET', '/assets/index-1a2b3c.css', 'cors', 'style')).toBe('hashed');
    expect(strategy('GET', '/src/main.tsx', 'cors', 'script')).toBe('asset');
    expect(strategy('GET', '/icons/icon-192.png', 'no-cors', 'image')).toBe('asset');
    expect(strategy('GET', '/manifest.webmanifest', 'cors', 'manifest')).toBe('asset');
    expect(strategy('GET', '/fonts/a.woff2', 'cors', 'font')).toBe('asset');
  });

  it('never touches API calls: reads from fetch() have no destination', () => {
    expect(strategy('GET', '/dpr/reports?projectId=p1')).toBeNull();
    expect(strategy('GET', '/me')).toBeNull();
    expect(strategy('GET', '/files/f1/url')).toBeNull();
  });

  it('never touches a write, whatever it is aimed at', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(strategy(method, '/dpr/reports', 'cors', '')).toBeNull();
      expect(strategy(method, '/assets/index.js', 'cors', 'script')).toBeNull();
      expect(strategy(method, '/', 'navigate', 'document')).toBeNull();
    }
  });

  it('never touches another site', () => {
    expect(
      rules.strategyFor('GET', 'https://api.other.test/dpr', 'cors', 'script', ORIGIN),
    ).toBeNull();
    expect(
      rules.strategyFor('GET', 'https://api.other.test/', 'navigate', 'document', ORIGIN),
    ).toBeNull();
  });

  it('leaves other kinds of request alone', () => {
    expect(strategy('GET', '/video.mp4', 'cors', 'video')).toBeNull();
    expect(strategy('GET', '/x', 'cors', 'worker')).toBeNull();
  });

  it('lists the shell files it keeps', () => {
    expect(rules.SHELL).toEqual(
      expect.arrayContaining(['/', '/manifest.webmanifest', '/icons/icon-192.png']),
    );
    expect(rules.CACHE).toMatch(/^ops-shell-v\d+$/);
  });
});

type Listener = (event: Record<string, unknown>) => void;

function loadWorker() {
  const listeners = new Map<string, Listener>();
  const store = new Map<string, Response>();
  const putCalls: string[] = [];
  const cacheNames = ['ops-shell-v0', 'ops-shell-v1'];
  const cache = {
    addAll: vi.fn(() => Promise.resolve()),
    put: vi.fn((key: string | { url: string }, response: Response) => {
      const name = typeof key === 'string' ? key : key.url;
      putCalls.push(name);
      store.set(name, response);
      return Promise.resolve();
    }),
  };
  const caches = {
    open: vi.fn(() => Promise.resolve(cache)),
    keys: vi.fn(() => Promise.resolve(cacheNames)),
    delete: vi.fn(() => Promise.resolve(true)),
    match: vi.fn((key: string | { url: string }) =>
      Promise.resolve(store.get(typeof key === 'string' ? key : key.url)),
    ),
  };
  const self = {
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: { claim: vi.fn(() => Promise.resolve()) },
    addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    swRules: undefined as Rules | undefined,
  };
  const importScripts = () => {
    runInNewContext(read('sw-rules.js'), { self, URL });
  };
  const fetchMock = vi.fn<(request: unknown) => Promise<Response>>();
  runInNewContext(read('sw.js'), {
    self,
    importScripts,
    caches,
    fetch: fetchMock,
    Response,
    URL,
  });
  return { listeners, store, putCalls, cache, caches, self, fetchMock };
}

const request = (method: string, path: string, mode: string, destination: string) => ({
  method,
  url: `${ORIGIN}${path}`,
  mode,
  destination,
});

/** Runs a fetch event; returns the answer the worker gave, or undefined when it let it pass. */
async function dispatch(
  worker: ReturnType<typeof loadWorker>,
  req: ReturnType<typeof request>,
): Promise<Response | undefined> {
  let answer: Promise<Response> | undefined;
  worker.listeners.get('fetch')?.({
    request: req,
    respondWith: (value: Promise<Response>) => (answer = value),
  });
  return answer;
}

describe('service worker (BR-1, T-6)', () => {
  let worker: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    worker = loadWorker();
  });

  it('stores the shell when installed and takes over at once', async () => {
    const waits: Promise<unknown>[] = [];
    worker.listeners.get('install')?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(worker.cache.addAll).toHaveBeenCalledWith(worker.self.swRules?.SHELL);
    expect(worker.self.skipWaiting).toHaveBeenCalled();
  });

  it('removes old caches when activated', async () => {
    const waits: Promise<unknown>[] = [];
    worker.listeners.get('activate')?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(worker.caches.delete).toHaveBeenCalledTimes(1);
    expect(worker.caches.delete).toHaveBeenCalledWith('ops-shell-v0');
    expect(worker.self.clients.claim).toHaveBeenCalled();
  });

  it('opens the shell offline: a navigation falls back to the cached page', async () => {
    worker.store.set('/', new Response('<html>shell</html>'));
    worker.fetchMock.mockRejectedValue(new TypeError('offline'));
    const answer = await dispatch(
      worker,
      request('GET', '/dpr/reports/new', 'navigate', 'document'),
    );
    expect(await answer?.text()).toBe('<html>shell</html>');
  });

  it('keeps a fresh copy of the shell while online', async () => {
    worker.fetchMock.mockResolvedValue(new Response('<html>fresh</html>'));
    const answer = await dispatch(worker, request('GET', '/anywhere', 'navigate', 'document'));
    expect(await answer?.text()).toBe('<html>fresh</html>');
    await vi.waitFor(() => expect(worker.putCalls).toEqual(['/']));
  });

  it('does not keep an error page', async () => {
    worker.fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const answer = await dispatch(worker, request('GET', '/', 'navigate', 'document'));
    expect(answer?.status).toBe(500);
    expect(worker.cache.put).not.toHaveBeenCalled();
  });

  it('fails the request when offline and nothing is cached', async () => {
    worker.fetchMock.mockRejectedValue(new TypeError('offline'));
    const answer = await dispatch(worker, request('GET', '/', 'navigate', 'document'));
    expect(answer?.type).toBe('error');
  });

  it('serves a built file from the cache without asking the network', async () => {
    const req = request('GET', '/assets/app-1.js', 'cors', 'script');
    worker.store.set(req.url, new Response('console.log(1)'));
    const answer = await dispatch(worker, req);
    expect(await answer?.text()).toBe('console.log(1)');
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it('fetches and keeps a built file it has not seen', async () => {
    worker.fetchMock.mockResolvedValue(new Response('console.log(2)'));
    const req = request('GET', '/assets/app-2.js', 'cors', 'script');
    const answer = await dispatch(worker, req);
    expect(await answer?.text()).toBe('console.log(2)');
    await vi.waitFor(() => expect(worker.putCalls).toEqual([req.url]));
  });

  it('prefers the network for other files and falls back to the cache offline', async () => {
    const req = request('GET', '/src/main.tsx', 'cors', 'script');
    worker.store.set(req.url, new Response('cached'));
    worker.fetchMock.mockRejectedValue(new TypeError('offline'));
    expect(await (await dispatch(worker, req))?.text()).toBe('cached');
  });

  it('lets API calls and every write go straight to the network', async () => {
    const calls = [
      request('GET', '/dpr/reports?projectId=p1', 'cors', ''),
      request('GET', '/me', 'cors', ''),
      request('POST', '/dpr/reports', 'cors', ''),
      request('PUT', '/attendance/sheets/t1/2026-10-30', 'cors', ''),
      request('POST', '/files', 'cors', ''),
    ];
    for (const call of calls) expect(await dispatch(worker, call)).toBeUndefined();
    expect(worker.fetchMock).not.toHaveBeenCalled();
    expect(worker.cache.put).not.toHaveBeenCalled();
    expect(worker.cache.addAll).not.toHaveBeenCalled();
  });
});
