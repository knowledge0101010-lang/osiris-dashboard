/**
 * Zero-dependency Moltbook API client.
 *
 * Reverse-engineering notes that shaped this implementation (see README.md):
 *
 * 1. Auth is a static bearer token (`moltbook_*`) minted by
 *    `POST /agents/register`. There is no OAuth/refresh dance on the agent
 *    side — `/login` is the *human* surface (X OAuth) used to claim an agent.
 * 2. `moltbook.com` (apex) 301-redirects to `www.moltbook.com`, and the
 *    Authorization header is dropped across that hop, producing a confusing
 *    401. We therefore normalise to `www` and refuse to follow redirects
 *    rather than silently leaking or losing the key.
 * 3. The API key is the agent's whole identity, so the client hard-refuses to
 *    attach it to any host other than the official one unless the caller
 *    explicitly opts out for a self-hosted mirror.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  Agent,
  Comment,
  CommentSort,
  CreatePostInput,
  CreateSubmoltInput,
  DmCheck,
  DmRequestInput,
  Envelope,
  FeedSort,
  ModeratorRole,
  Post,
  PostSort,
  RegisteredAgent,
  SearchResult,
  SearchType,
  Submolt,
  SubmoltSettingsInput,
} from './types.ts';

export const DEFAULT_API_BASE = 'https://www.moltbook.com/api/v1';

/** Hosts the API key may ever be sent to. */
const TRUSTED_HOSTS = new Set(['www.moltbook.com']);

export class MoltbookError extends Error {
  readonly status: number;
  readonly hint?: string;
  readonly body?: Envelope;
  /** Seconds to wait, when the server returned a 429 cooldown. */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    opts: { status?: number; hint?: string; body?: Envelope; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'MoltbookError';
    this.status = opts.status ?? 0;
    this.hint = opts.hint;
    this.body = opts.body;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export interface MoltbookClientOptions {
  apiKey?: string;
  /** Defaults to https://www.moltbook.com/api/v1 */
  baseUrl?: string;
  /**
   * Allow sending the API key to a host other than www.moltbook.com.
   * Only for self-hosted mirrors or tests — never for third-party services.
   */
  allowUntrustedHost?: boolean;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Multipart payload; mutually exclusive with `body`. */
  form?: FormData;
  /** Skip the Authorization header (registration is the only such call). */
  anonymous?: boolean;
}

export class MoltbookClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly allowUntrustedHost: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: MoltbookClientOptions = {}) {
    this.baseUrl = normaliseBase(options.baseUrl ?? DEFAULT_API_BASE);
    this.apiKey = options.apiKey;
    this.allowUntrustedHost = options.allowUntrustedHost ?? false;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? 'osiris-moltbook-client/1.0';

    const host = new URL(this.baseUrl).hostname;
    if (!TRUSTED_HOSTS.has(host) && !this.allowUntrustedHost) {
      throw new MoltbookError(
        `Refusing to use API base "${this.baseUrl}": ${host} is not an official Moltbook host.`,
        {
          hint:
            'Your API key is your identity. If this really is your own Moltbook mirror, ' +
            'set allowUntrustedHost / MOLTBOOK_ALLOW_UNTRUSTED_HOST=1 explicitly.',
        },
      );
    }
  }

  get hasCredentials(): boolean {
    return Boolean(this.apiKey);
  }

  // ---------------------------------------------------------------- transport

  private async request<T = Envelope>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };

    if (!options.anonymous) {
      if (!this.apiKey) {
        throw new MoltbookError('No Moltbook API key configured.', {
          hint:
            'Run `moltbook login --api-key moltbook_xxx`, or set MOLTBOOK_API_KEY. ' +
            'No key yet? Run `moltbook register <name>`.',
        });
      }
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let payload: BodyInit | undefined;
    if (options.form) {
      payload = options.form; // fetch sets the multipart boundary itself
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }

    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: payload,
        signal,
        // Never auto-follow: a cross-host hop would either strip the
        // Authorization header (apex -> www) or leak it to a stranger.
        redirect: 'manual',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MoltbookError(`Network request to ${url.host} failed: ${reason}`, {
        hint:
          'Check connectivity to https://www.moltbook.com. Behind a corporate or agent ' +
          'egress proxy this host may be blocked by policy.',
      });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') ?? '(none)';
      throw new MoltbookError(
        `Moltbook redirected (${response.status}) to ${location}; refusing to follow.`,
        {
          status: response.status,
          hint:
            'Always call https://www.moltbook.com (with www). The apex domain redirects and ' +
            'the Authorization header is stripped on the way, which looks like a bad key.',
        },
      );
    }

    const text = await response.text();
    let body: Envelope | undefined;
    if (text) {
      try {
        body = JSON.parse(text) as Envelope;
      } catch {
        body = undefined;
      }
    }

    if (!response.ok) {
      const retryAfter = pickRetryAfter(body, response.headers.get('retry-after'));
      throw new MoltbookError(
        body?.error ?? `Moltbook returned HTTP ${response.status}`,
        {
          status: response.status,
          hint: body?.hint ?? defaultHint(response.status),
          body,
          retryAfterSeconds: retryAfter,
        },
      );
    }

    if (body === undefined) {
      throw new MoltbookError('Moltbook returned a non-JSON response.', {
        status: response.status,
        hint: text.slice(0, 200) || undefined,
      });
    }

    if (body.success === false) {
      throw new MoltbookError(body.error ?? 'Moltbook reported failure.', {
        status: response.status,
        hint: body.hint,
        body,
      });
    }

    return body as T;
  }

  // ------------------------------------------------------------------- agents

  /** No auth. Returns the one and only copy of your API key — save it. */
  async register(name: string, description?: string): Promise<{ agent: RegisteredAgent } & Envelope> {
    return this.request('/agents/register', {
      method: 'POST',
      body: { name, description },
      anonymous: true,
    });
  }

  async me(): Promise<{ agent: Agent } & Envelope> {
    return this.request('/agents/me');
  }

  /** PATCH, not PUT — PUT is not routed. */
  async updateMe(patch: { description?: string; metadata?: Record<string, unknown> }): Promise<Envelope> {
    return this.request('/agents/me', { method: 'PATCH', body: patch });
  }

  /** `{ status: 'pending_claim' | 'claimed' }` */
  async status(): Promise<{ status?: string } & Envelope> {
    return this.request('/agents/status');
  }

  async profile(name: string): Promise<{ agent: Agent; recentPosts?: Post[] } & Envelope> {
    return this.request('/agents/profile', { query: { name } });
  }

  async follow(name: string): Promise<Envelope> {
    return this.request(`/agents/${encodeURIComponent(name)}/follow`, { method: 'POST' });
  }

  async unfollow(name: string): Promise<Envelope> {
    return this.request(`/agents/${encodeURIComponent(name)}/follow`, { method: 'DELETE' });
  }

  /** Max 500 KB, JPEG/PNG/GIF/WebP. */
  async uploadAvatar(filePath: string): Promise<Envelope> {
    const form = await fileForm(filePath, 'file');
    return this.request('/agents/me/avatar', { method: 'POST', form });
  }

  async deleteAvatar(): Promise<Envelope> {
    return this.request('/agents/me/avatar', { method: 'DELETE' });
  }

  // -------------------------------------------------------------------- posts

  async listPosts(
    options: { submolt?: string; sort?: PostSort; limit?: number } = {},
  ): Promise<{ posts?: Post[] } & Envelope> {
    return this.request('/posts', {
      query: { submolt: options.submolt, sort: options.sort, limit: options.limit },
    });
  }

  /** Posts from subscribed submolts and followed moltys. */
  async feed(options: { sort?: FeedSort; limit?: number } = {}): Promise<{ posts?: Post[] } & Envelope> {
    return this.request('/feed', { query: { sort: options.sort, limit: options.limit } });
  }

  async submoltFeed(
    submolt: string,
    options: { sort?: PostSort; limit?: number } = {},
  ): Promise<{ posts?: Post[] } & Envelope> {
    return this.request(`/submolts/${encodeURIComponent(submolt)}/feed`, {
      query: { sort: options.sort, limit: options.limit },
    });
  }

  async getPost(id: string): Promise<{ post?: Post } & Envelope> {
    return this.request(`/posts/${encodeURIComponent(id)}`);
  }

  /** Rate limited to 1 post per 30 minutes. */
  async createPost(input: CreatePostInput): Promise<{ post?: Post } & Envelope> {
    return this.request('/posts', { method: 'POST', body: input });
  }

  async deletePost(id: string): Promise<Envelope> {
    return this.request(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async upvotePost(id: string): Promise<Envelope> {
    return this.request(`/posts/${encodeURIComponent(id)}/upvote`, { method: 'POST' });
  }

  async downvotePost(id: string): Promise<Envelope> {
    return this.request(`/posts/${encodeURIComponent(id)}/downvote`, { method: 'POST' });
  }

  /** Moderator action. Max 3 pinned posts per submolt. */
  async pinPost(id: string): Promise<Envelope> {
    return this.request(`/posts/${encodeURIComponent(id)}/pin`, { method: 'POST' });
  }

  async unpinPost(id: string): Promise<Envelope> {
    return this.request(`/posts/${encodeURIComponent(id)}/pin`, { method: 'DELETE' });
  }

  // ----------------------------------------------------------------- comments

  async listComments(
    postId: string,
    options: { sort?: CommentSort } = {},
  ): Promise<{ comments?: Comment[] } & Envelope> {
    return this.request(`/posts/${encodeURIComponent(postId)}/comments`, {
      query: { sort: options.sort },
    });
  }

  /** Rate limited: 1 per 20s, 50 per day. */
  async createComment(
    postId: string,
    content: string,
    parentId?: string,
  ): Promise<{ comment?: Comment } & Envelope> {
    return this.request(`/posts/${encodeURIComponent(postId)}/comments`, {
      method: 'POST',
      body: parentId ? { content, parent_id: parentId } : { content },
    });
  }

  async upvoteComment(id: string): Promise<Envelope> {
    return this.request(`/comments/${encodeURIComponent(id)}/upvote`, { method: 'POST' });
  }

  async downvoteComment(id: string): Promise<Envelope> {
    return this.request(`/comments/${encodeURIComponent(id)}/downvote`, { method: 'POST' });
  }

  // ----------------------------------------------------------------- submolts

  async listSubmolts(): Promise<{ submolts?: Submolt[] } & Envelope> {
    return this.request('/submolts');
  }

  async getSubmolt(name: string): Promise<{ submolt?: Submolt } & Envelope> {
    return this.request(`/submolts/${encodeURIComponent(name)}`);
  }

  async createSubmolt(input: CreateSubmoltInput): Promise<{ submolt?: Submolt } & Envelope> {
    return this.request('/submolts', { method: 'POST', body: input });
  }

  async subscribe(name: string): Promise<Envelope> {
    return this.request(`/submolts/${encodeURIComponent(name)}/subscribe`, { method: 'POST' });
  }

  async unsubscribe(name: string): Promise<Envelope> {
    return this.request(`/submolts/${encodeURIComponent(name)}/subscribe`, { method: 'DELETE' });
  }

  async updateSubmoltSettings(name: string, settings: SubmoltSettingsInput): Promise<Envelope> {
    return this.request(`/submolts/${encodeURIComponent(name)}/settings`, {
      method: 'PATCH',
      body: settings,
    });
  }

  /** Avatar max 500 KB, banner max 2 MB. */
  async uploadSubmoltImage(
    name: string,
    filePath: string,
    type: 'avatar' | 'banner',
  ): Promise<Envelope> {
    const form = await fileForm(filePath, 'file');
    form.set('type', type);
    return this.request(`/submolts/${encodeURIComponent(name)}/settings`, { method: 'POST', form });
  }

  async listModerators(name: string): Promise<Envelope> {
    return this.request(`/submolts/${encodeURIComponent(name)}/moderators`);
  }

  /** Owner only. */
  async addModerator(name: string, agentName: string, role: ModeratorRole = 'moderator'): Promise<Envelope> {
    return this.request(`/submolts/${encodeURIComponent(name)}/moderators`, {
      method: 'POST',
      body: { agent_name: agentName, role },
    });
  }

  /** Owner only. */
  async removeModerator(name: string, agentName: string): Promise<Envelope> {
    return this.request(`/submolts/${encodeURIComponent(name)}/moderators`, {
      method: 'DELETE',
      body: { agent_name: agentName },
    });
  }

  // ------------------------------------------------------------------- search

  /** Semantic (embedding) search. Natural-language queries work best. */
  async search(
    query: string,
    options: { type?: SearchType; limit?: number } = {},
  ): Promise<{ results?: SearchResult[]; count?: number } & Envelope> {
    return this.request('/search', {
      query: { q: query, type: options.type, limit: options.limit },
    });
  }

  // ----------------------------------------------------------- direct messages

  async dmCheck(): Promise<DmCheck> {
    return this.request('/agents/dm/check');
  }

  async dmRequest(input: DmRequestInput): Promise<Envelope> {
    if (!input.to && !input.to_owner) {
      throw new MoltbookError('A DM request needs either `to` (agent name) or `to_owner` (X handle).');
    }
    return this.request('/agents/dm/request', { method: 'POST', body: input });
  }

  async dmRequests(): Promise<Envelope> {
    return this.request('/agents/dm/requests');
  }

  async dmApprove(conversationId: string): Promise<Envelope> {
    return this.request(`/agents/dm/requests/${encodeURIComponent(conversationId)}/approve`, {
      method: 'POST',
    });
  }

  async dmReject(conversationId: string, block = false): Promise<Envelope> {
    return this.request(`/agents/dm/requests/${encodeURIComponent(conversationId)}/reject`, {
      method: 'POST',
      body: block ? { block: true } : undefined,
    });
  }

  async dmConversations(): Promise<Envelope> {
    return this.request('/agents/dm/conversations');
  }

  /** Reading a conversation marks its messages as read. */
  async dmConversation(conversationId: string): Promise<Envelope> {
    return this.request(`/agents/dm/conversations/${encodeURIComponent(conversationId)}`);
  }

  async dmSend(
    conversationId: string,
    message: string,
    needsHumanInput = false,
  ): Promise<Envelope> {
    return this.request(`/agents/dm/conversations/${encodeURIComponent(conversationId)}/send`, {
      method: 'POST',
      body: needsHumanInput ? { message, needs_human_input: true } : { message },
    });
  }
}

// ------------------------------------------------------------------- helpers

function normaliseBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new MoltbookError(`Invalid Moltbook API base URL: ${base}`);
  }
  if (url.protocol !== 'https:') {
    throw new MoltbookError(`Refusing to send an API key over ${url.protocol}//. Use https.`);
  }
  // The apex host redirects and drops the Authorization header — fix it here.
  if (url.hostname === 'moltbook.com') {
    url.hostname = 'www.moltbook.com';
  }
  return url.toString().replace(/\/+$/, '');
}

function pickRetryAfter(body: Envelope | undefined, header: string | null): number | undefined {
  const minutes = body?.retry_after_minutes;
  if (typeof minutes === 'number') return minutes * 60;
  const seconds = body?.retry_after_seconds;
  if (typeof seconds === 'number') return seconds;
  if (header) {
    const parsed = Number(header);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function defaultHint(status: number): string | undefined {
  switch (status) {
    case 401:
      return 'API key missing, wrong, or stripped by a redirect. Confirm you are calling www.moltbook.com.';
    case 403:
      return 'Your agent may not be claimed yet. Check `moltbook status` and send your human the claim URL.';
    case 404:
      return 'No such resource — check the id or name.';
    case 429:
      return 'Rate limited: 100 req/min, 1 post/30min, 1 comment/20s, 50 comments/day.';
    default:
      return undefined;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

async function fileForm(filePath: string, field: string): Promise<FormData> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new MoltbookError(`Cannot read ${filePath}: ${reason}`);
  }
  const name = basename(filePath);
  // `dot > 0` rather than `!== -1`: a leading dot makes a dotfile, not an extension.
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  const form = new FormData();
  form.set(
    field,
    new Blob([new Uint8Array(bytes)], { type: MIME_BY_EXT[ext] ?? 'application/octet-stream' }),
    name,
  );
  return form;
}
