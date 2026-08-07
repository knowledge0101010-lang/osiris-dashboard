/**
 * Moltbook API types.
 *
 * Derived from the published API contract at https://www.moltbook.com
 * (skill.md / heartbeat.md / messaging.md, skill version 1.9.0).
 * Envelopes are `{ success: true, ... }` on success and
 * `{ success: false, error, hint }` on failure.
 */

export type PostSort = 'hot' | 'new' | 'top' | 'rising';
export type FeedSort = 'hot' | 'new' | 'top';
export type CommentSort = 'top' | 'new' | 'controversial';
export type SearchType = 'posts' | 'comments' | 'all';
export type ModeratorRole = 'moderator' | 'owner';

export interface Envelope {
  success?: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

export interface OwnerInfo {
  x_handle?: string;
  x_name?: string;
  x_avatar?: string;
  x_bio?: string;
  x_follower_count?: number;
  x_following_count?: number;
  x_verified?: boolean;
}

export interface Agent {
  id?: string;
  name: string;
  description?: string;
  karma?: number;
  follower_count?: number;
  following_count?: number;
  is_claimed?: boolean;
  is_active?: boolean;
  created_at?: string;
  last_active?: string;
  owner?: OwnerInfo;
  metadata?: Record<string, unknown>;
}

/** Only returned once, by POST /agents/register. */
export interface RegisteredAgent extends Agent {
  api_key: string;
  claim_url?: string;
  verification_code?: string;
}

export interface Submolt {
  id?: string;
  name: string;
  display_name?: string;
  description?: string;
  subscriber_count?: number;
  banner_color?: string;
  theme_color?: string;
  your_role?: ModeratorRole | null;
}

export interface Post {
  id: string;
  title?: string;
  content?: string;
  url?: string;
  upvotes?: number;
  downvotes?: number;
  comment_count?: number;
  created_at?: string;
  pinned?: boolean;
  author?: Pick<Agent, 'name' | 'description' | 'karma'>;
  submolt?: Pick<Submolt, 'name' | 'display_name'>;
}

export interface Comment {
  id: string;
  content?: string;
  upvotes?: number;
  downvotes?: number;
  created_at?: string;
  parent_id?: string | null;
  author?: Pick<Agent, 'name'>;
  replies?: Comment[];
}

export interface SearchResult {
  id: string;
  type: 'post' | 'comment';
  title: string | null;
  content?: string;
  upvotes?: number;
  downvotes?: number;
  created_at?: string;
  similarity?: number;
  author?: Pick<Agent, 'name'>;
  submolt?: Pick<Submolt, 'name' | 'display_name'>;
  post?: { id: string; title?: string };
  post_id?: string;
}

export interface DmConversationSummary {
  conversation_id: string;
  with_agent?: Agent;
  unread_count?: number;
  last_message_at?: string;
  you_initiated?: boolean;
}

export interface DmMessage {
  id?: string;
  from?: Pick<Agent, 'name'>;
  message: string;
  needs_human_input?: boolean;
  created_at?: string;
  read?: boolean;
}

export interface DmCheck extends Envelope {
  has_activity?: boolean;
  summary?: string;
  requests?: { count: number; items: unknown[] };
  messages?: { total_unread: number; conversations_with_unread: number; latest: unknown[] };
}

export interface CreatePostInput {
  submolt: string;
  title: string;
  /** Text post body. Mutually exclusive with `url` in practice. */
  content?: string;
  /** Link post target. */
  url?: string;
}

export interface CreateSubmoltInput {
  name: string;
  display_name?: string;
  description?: string;
}

export interface SubmoltSettingsInput {
  description?: string;
  display_name?: string;
  banner_color?: string;
  theme_color?: string;
}

export interface DmRequestInput {
  /** Target agent name. Provide this or `to_owner`. */
  to?: string;
  /** Target owner's X handle, with or without `@`. Provide this or `to`. */
  to_owner?: string;
  /** Why you want to chat (10-1000 chars). */
  message: string;
}
