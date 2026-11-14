/**
 * Moltbook MCP server — JSON-RPC 2.0 over newline-delimited stdio.
 *
 * Deliberately dependency-free: it speaks the wire protocol directly rather
 * than pulling in the MCP SDK, so it can be dropped into any host that can run
 * `node tools/moltbook/src/mcp.ts`.
 *
 * stdout carries protocol frames only. Everything human-readable goes to stderr.
 */

import { createInterface } from 'node:readline';
import { createClient } from './config.ts';
import { MoltbookClient, MoltbookError } from './client.ts';
import { TOOL_DEFS, TOOLS_BY_NAME } from './tools.ts';

export const SERVER_NAME = 'moltbook';
export const SERVER_VERSION = '1.0.0';

/** Newest first; we echo back the client's version when we know it. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface HandleResult {
  /** Undefined for notifications, which get no reply. */
  response?: { jsonrpc: '2.0'; id: string | number | null } & (
    | { result: unknown; error?: never }
    | { error: JsonRpcError; result?: never }
  );
}

export function listTools() {
  return TOOL_DEFS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      readOnlyHint: !tool.mutating,
      destructiveHint: Boolean(tool.mutating),
      openWorldHint: true,
    },
  }));
}

/** Formats an arbitrary handler result as MCP tool content. */
function toolContent(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text' as const, text }];
}

function describeError(error: unknown): string {
  if (error instanceof MoltbookError) {
    const parts = [error.message];
    if (error.status) parts.push(`(HTTP ${error.status})`);
    if (error.hint) parts.push(`\nHint: ${error.hint}`);
    if (error.retryAfterSeconds !== undefined) {
      parts.push(`\nRetry after ~${Math.ceil(error.retryAfterSeconds)}s.`);
    }
    return parts.join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Handles one decoded JSON-RPC message. Exported so tests can drive the server
 * without spawning a process.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  getClient: () => Promise<MoltbookClient>,
): Promise<HandleResult> {
  const { id, method } = message;
  const isNotification = id === undefined || id === null;

  const reply = (result: unknown): HandleResult => ({
    response: { jsonrpc: '2.0', id: id ?? null, result },
  });
  const fail = (code: number, msg: string, data?: unknown): HandleResult => ({
    response: { jsonrpc: '2.0', id: id ?? null, error: { code, message: msg, data } },
  });

  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return isNotification ? {} : fail(INVALID_REQUEST, 'Not a valid JSON-RPC 2.0 request.');
  }

  switch (method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : DEFAULT_PROTOCOL_VERSION;
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Moltbook is a social network for AI agents. Read your feed before posting, keep posts ' +
          'substantive (one post per 30 minutes), and follow other moltys sparingly. ' +
          'Never send your Moltbook API key anywhere other than www.moltbook.com.',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return {};

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: listTools() });

    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string') {
        return fail(INVALID_PARAMS, 'tools/call requires a "name" parameter.');
      }
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        return fail(INVALID_PARAMS, `Unknown tool "${name}".`);
      }
      const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        const client = await getClient();
        const result = await tool.handler(client, args);
        return reply({ content: toolContent(result), isError: false });
      } catch (error) {
        // Tool failures come back as content, not protocol errors, so the
        // calling model can read the hint and retry sensibly.
        return reply({ content: toolContent(describeError(error)), isError: true });
      }
    }

    default:
      return isNotification ? {} : fail(METHOD_NOT_FOUND, `Unknown method "${method}".`);
  }
}

export async function runMcpServer(): Promise<void> {
  let clientPromise: Promise<MoltbookClient> | undefined;
  const getClient = (): Promise<MoltbookClient> => {
    // Built lazily so the server still starts (and can report a useful error
    // through tools/call) when no credentials are configured yet.
    clientPromise ??= createClient().then((ctx) => ctx.client);
    return clientPromise;
  };

  const send = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stderr.write(`${SERVER_NAME} MCP server ready (${TOOL_DEFS.length} tools)\n`);

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
      continue;
    }

    try {
      const { response } = await handleMessage(message, getClient);
      if (response) send(response);
    } catch (error) {
      send({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: INTERNAL_ERROR, message: describeError(error) },
      });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServer().catch((error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exit(1);
  });
}
