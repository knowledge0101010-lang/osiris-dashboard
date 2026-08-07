import { describe, expect, it } from 'vitest';
import { MoltbookClient } from './client.ts';
import { handleMessage, listTools, SERVER_NAME } from './mcp.ts';
import { TOOL_DEFS } from './tools.ts';

function fakeClient(
  handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown },
): MoltbookClient {
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const { status = 200, body = { success: true } } = handler(String(input), init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return new MoltbookClient({ apiKey: 'moltbook_test', fetchImpl });
}

const getClient = (client: MoltbookClient) => async () => client;

describe('MCP protocol', () => {
  it('answers initialize with tool capabilities', async () => {
    const { response } = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      getClient(fakeClient(() => ({}))),
    );
    expect(response?.result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME },
    });
  });

  it('falls back to the newest protocol version for unknown requests', async () => {
    const { response } = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      getClient(fakeClient(() => ({}))),
    );
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it('never replies to notifications', async () => {
    const result = await handleMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      getClient(fakeClient(() => ({}))),
    );
    expect(result.response).toBeUndefined();
  });

  it('answers ping', async () => {
    const { response } = await handleMessage(
      { jsonrpc: '2.0', id: 7, method: 'ping' },
      getClient(fakeClient(() => ({}))),
    );
    expect(response?.result).toEqual({});
  });

  it('rejects unknown methods', async () => {
    const { response } = await handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'resources/read' },
      getClient(fakeClient(() => ({}))),
    );
    expect(response?.error?.code).toBe(-32601);
  });
});

describe('MCP tool registry', () => {
  it('exposes every tool with a unique namespaced name and a schema', () => {
    const tools = listTools();
    expect(tools.length).toBe(TOOL_DEFS.length);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^moltbook_[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
      for (const key of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties).toHaveProperty(key);
      }
    }
  });

  it('marks read-only tools as such', () => {
    const byName = new Map(listTools().map((t) => [t.name, t]));
    expect(byName.get('moltbook_feed')?.annotations.readOnlyHint).toBe(true);
    expect(byName.get('moltbook_create_post')?.annotations.readOnlyHint).toBe(false);
  });
});

describe('MCP tools/call', () => {
  it('dispatches a tool to the API', async () => {
    const seen: string[] = [];
    const client = fakeClient((url) => {
      seen.push(url);
      return { body: { success: true, posts: [{ id: 'p1', title: 'Hello' }] } };
    });

    const { response } = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'moltbook_feed', arguments: { sort: 'new', limit: 5 } },
      },
      getClient(client),
    );

    expect(seen[0]).toBe('https://www.moltbook.com/api/v1/feed?sort=new&limit=5');
    const result = response?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).posts[0].title).toBe('Hello');
  });

  it('routes vote direction to the right endpoint', async () => {
    const seen: string[] = [];
    const client = fakeClient((url) => {
      seen.push(url);
      return {};
    });
    await handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'moltbook_vote_post', arguments: { post_id: 'p1', direction: 'down' } },
      },
      getClient(client),
    );
    expect(seen[0]).toBe('https://www.moltbook.com/api/v1/posts/p1/downvote');
  });

  it('reports API failures as tool content, not protocol errors', async () => {
    const client = fakeClient(() => ({
      status: 429,
      body: { success: false, error: 'One post per 30 minutes', retry_after_minutes: 8 },
    }));

    const { response } = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'moltbook_create_post', arguments: { submolt: 'general', title: 'hi' } },
      },
      getClient(client),
    );

    expect(response?.error).toBeUndefined();
    const result = response?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('One post per 30 minutes');
    expect(result.content[0].text).toContain('480s');
  });

  it('validates missing required arguments before calling out', async () => {
    let called = false;
    const client = fakeClient(() => {
      called = true;
      return {};
    });
    const { response } = await handleMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'moltbook_get_post', arguments: {} } },
      getClient(client),
    );
    const result = response?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('post_id');
    expect(called).toBe(false);
  });

  it('rejects an unknown tool name', async () => {
    const { response } = await handleMessage(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'moltbook_nope' } },
      getClient(fakeClient(() => ({}))),
    );
    expect(response?.error?.code).toBe(-32602);
  });
});
