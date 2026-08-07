import { describe, expect, it } from 'vitest';
import { MoltbookClient, MoltbookError } from './client.ts';

interface Capture {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: RequestRedirect;
}

function stubFetch(
  response: { status?: number; body?: unknown; headers?: Record<string, string> } = {},
): { fetchImpl: typeof fetch; calls: Capture[] } {
  const calls: Capture[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url: String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    });
    const status = response.status ?? 200;
    return new Response(JSON.stringify(response.body ?? { success: true }), {
      status,
      headers: { 'content-type': 'application/json', ...(response.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch, apiKey = 'moltbook_test_key'): MoltbookClient {
  return new MoltbookClient({ apiKey, fetchImpl });
}

describe('MoltbookClient transport', () => {
  it('builds the documented URL and attaches the bearer token', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { success: true, posts: [] } });
    await client(fetchImpl).listPosts({ submolt: 'general', sort: 'new', limit: 10 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://www.moltbook.com/api/v1/posts?submolt=general&sort=new&limit=10',
    );
    expect(calls[0].headers.authorization).toBe('Bearer moltbook_test_key');
    // A silent redirect would either strip the header or leak it elsewhere.
    expect(calls[0].redirect).toBe('manual');
  });

  it('omits empty query parameters', async () => {
    const { fetchImpl, calls } = stubFetch();
    await client(fetchImpl).feed({});
    expect(calls[0].url).toBe('https://www.moltbook.com/api/v1/feed');
  });

  it('registers without an Authorization header', async () => {
    const { fetchImpl, calls } = stubFetch({ body: { success: true, agent: { api_key: 'moltbook_x' } } });
    await new MoltbookClient({ fetchImpl }).register('Osiris', 'intel agent');

    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].method).toBe('POST');
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ name: 'Osiris', description: 'intel agent' });
  });

  it('uses PATCH for profile updates, not PUT', async () => {
    const { fetchImpl, calls } = stubFetch();
    await client(fetchImpl).updateMe({ description: 'new' });
    expect(calls[0].method).toBe('PATCH');
  });

  it('percent-encodes path parameters', async () => {
    const { fetchImpl, calls } = stubFetch();
    await client(fetchImpl).follow('Molty Bot/../admin');
    expect(calls[0].url).toBe(
      'https://www.moltbook.com/api/v1/agents/Molty%20Bot%2F..%2Fadmin/follow',
    );
  });

  it('sends parent_id only when replying', async () => {
    const { fetchImpl, calls } = stubFetch();
    const api = client(fetchImpl);
    await api.createComment('p1', 'top level');
    await api.createComment('p1', 'a reply', 'c9');

    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ content: 'top level' });
    expect(JSON.parse(calls[1].body ?? '{}')).toEqual({ content: 'a reply', parent_id: 'c9' });
  });
});

describe('MoltbookClient host safety', () => {
  it('rewrites the apex host that strips Authorization headers', () => {
    const api = new MoltbookClient({ apiKey: 'k', baseUrl: 'https://moltbook.com/api/v1' });
    expect(api.baseUrl).toBe('https://www.moltbook.com/api/v1');
  });

  it('refuses to send the key to a third-party host', () => {
    expect(() => new MoltbookClient({ apiKey: 'k', baseUrl: 'https://evil.example/api/v1' })).toThrow(
      /not an official Moltbook host/,
    );
  });

  it('allows an explicitly trusted self-hosted mirror', () => {
    const api = new MoltbookClient({
      apiKey: 'k',
      baseUrl: 'https://mirror.internal/api/v1',
      allowUntrustedHost: true,
    });
    expect(api.baseUrl).toBe('https://mirror.internal/api/v1');
  });

  it('refuses plaintext http', () => {
    expect(
      () => new MoltbookClient({ apiKey: 'k', baseUrl: 'http://www.moltbook.com/api/v1' }),
    ).toThrow(/Use https/);
  });

  it('does not follow redirects', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } })) as
      unknown as typeof fetch;
    await expect(client(fetchImpl).me()).rejects.toThrow(/refusing to follow/i);
  });
});

describe('MoltbookClient error handling', () => {
  it('requires credentials for authenticated calls', async () => {
    const { fetchImpl } = stubFetch();
    await expect(new MoltbookClient({ fetchImpl }).me()).rejects.toThrow(/No Moltbook API key/);
  });

  it('surfaces the server error and hint', async () => {
    const { fetchImpl } = stubFetch({
      status: 403,
      body: { success: false, error: 'Agent not claimed', hint: 'Ask your human' },
    });
    await expect(client(fetchImpl).createPost({ submolt: 'general', title: 'x' })).rejects.toMatchObject({
      message: 'Agent not claimed',
      status: 403,
      hint: 'Ask your human',
    });
  });

  it('converts the post cooldown into seconds', async () => {
    const { fetchImpl } = stubFetch({
      status: 429,
      body: { success: false, error: 'Slow down', retry_after_minutes: 12 },
    });
    const error = await client(fetchImpl)
      .createPost({ submolt: 'general', title: 'x' })
      .catch((e: unknown) => e as MoltbookError);
    expect(error).toBeInstanceOf(MoltbookError);
    expect((error as MoltbookError).retryAfterSeconds).toBe(720);
  });

  it('reads the comment cooldown in seconds', async () => {
    const { fetchImpl } = stubFetch({
      status: 429,
      body: { success: false, error: 'Slow down', retry_after_seconds: 20 },
    });
    const error = await client(fetchImpl)
      .createComment('p1', 'hi')
      .catch((e: unknown) => e as MoltbookError);
    expect((error as MoltbookError).retryAfterSeconds).toBe(20);
  });

  it('treats a success:false body as an error even on HTTP 200', async () => {
    const { fetchImpl } = stubFetch({ body: { success: false, error: 'Nope' } });
    await expect(client(fetchImpl).me()).rejects.toThrow('Nope');
  });

  it('reports network failures without leaking the key', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;
    const error = await client(fetchImpl)
      .me()
      .catch((e: unknown) => e as MoltbookError);
    expect((error as MoltbookError).message).toContain('www.moltbook.com');
    expect((error as MoltbookError).message).not.toContain('moltbook_test_key');
  });

  it('rejects a DM request with no recipient', async () => {
    const { fetchImpl, calls } = stubFetch();
    await expect(client(fetchImpl).dmRequest({ message: 'hello there' })).rejects.toThrow(
      /`to`.*`to_owner`/,
    );
    expect(calls).toHaveLength(0);
  });
});
