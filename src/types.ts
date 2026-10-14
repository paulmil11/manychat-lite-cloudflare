// Shapes shared by the Worker and the dashboard renderer.

// Where a keyword automation listens: comments on your posts, DMs, and replies to your stories.
export type Channel = "comments" | "dms" | "stories";
export const CHANNELS: readonly Channel[] = ["comments", "dms", "stories"];

export type Rule = {
  id: number;
  label: string;
  channels: Channel[];
  keywords: string[];
  replyText: string;
  publicReplyText: string | null;
  linkUrl: string | null;
  linkButtonLabel: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type RecentEventRow = {
  comment_id: string;
  username: string | null;
  comment_text: string;
  status: string;
  rule_label: string | null;
  matched_keyword: string | null;
  error: string | null;
  received_at: string;
  sent_at: string | null;
};

export type ActivityFilters = {
  status: string;
  keyword: string;
  username: string;
  date: string;
};

export type RecentMessageRow = {
  message_id: string;
  sender_id: string;
  message_text: string;
  source: string;
  reply_key: string | null;
  matched_choice: string | null;
  status: string;
  error: string | null;
  received_at: string;
  sent_at: string | null;
  story_id: string | null;
  story_url: string | null;
  story_link_url: string | null;
  referral_ref: string | null;
  sender_username: string | null;
  is_follower: number | null;
  profile_error: string | null;
  profile_checked_at: string | null;
};

// All-time totals for the overview cards. "sent" counts delivered DMs only;
// test-mode matches are counted separately.
export type DashboardStats = {
  comments: number;
  messages: number;
  sent: number;
  errors: number;
  testMatches: number;
};

// One row per reply a comment or DM can trigger: keyword rules (comments and
// DMs) and custom text replies (DMs only).
export type ReplyStatsRow = {
  key: string;
  label: string;
  kind: "rule" | "fallback" | "text";
  commentMatches: number;
  dmMatches: number;
  sent: number;
  errors: number;
  lastSentAt: string | null;
};
