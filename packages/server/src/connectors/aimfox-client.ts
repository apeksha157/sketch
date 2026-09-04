import { createHash } from "node:crypto";
import { acquireRpmSlot } from "./rpm-pacer";

const AIMFOX_BASE_URL = "https://api.aimfox.com/api/v2";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_RPM = 60;
const MAX_CONVERSATION_PAGE = 100;

export interface AimfoxAccount {
  id: string;
  urn: string;
  full_name: string;
  public_identifier: string;
  picture_url: string;
  state: string;
  disabled: boolean;
}

export interface AimfoxLeadTarget {
  urn: string;
  full_name: string;
  picture_url: string;
  occupation: string;
}

export interface AimfoxRecentLead {
  timestamp: string;
  account_id: string;
  campaign_id: string;
  campaign_name: string;
  target_id: string;
  target_urn: string;
  transition: string;
  target: AimfoxLeadTarget;
}

export interface AimfoxLeadCompany {
  urn: string;
  name: string;
  universal_name: string;
}

export interface AimfoxLeadExperience {
  company: AimfoxLeadCompany;
  job_title: string;
  start_date: { month?: number; year?: number };
  end_date?: { month?: number; year?: number };
  location?: { name: string };
}

export interface AimfoxLead {
  id: string;
  urn: string;
  first_name: string;
  last_name: string;
  full_name: string;
  public_identifier: string;
  occupation: string;
  picture_url: string;
  location: { name: string; urn?: string } | null;
  about: string | null;
  premium?: boolean;
  connections?: number;
  followers?: number;
  websites?: Array<string | { url?: string; label?: string }>;
  current_experience: AimfoxLeadExperience[];
  work_experience: AimfoxLeadExperience[];
  education: unknown[];
  skills: Array<{ name: string }>;
  certifications: unknown[];
  languages: Array<{ name: string; proficiency: string }>;
  contact_info: {
    phone_numbers?: Array<{ number: string; type: string; country?: string }>;
    birthday?: { month: number; day: number };
  };
  phones: Array<{ number: string; type: string; country?: string }>;
  email?: string;
  emails?: Array<{ address: string; type?: string }>;
  labels: unknown[];
  notes: unknown[];
  is_lead: boolean;
  lead_of: string[];
  origins: Array<{ id: string; name: string }>;
}

export interface AimfoxSearchResult {
  status: string;
  leads: Array<{
    id: string;
    urn: string;
    full_name: string;
    public_identifier: string;
    occupation: string;
    picture_url: string;
    location?: { name: string };
  }>;
}

export interface AimfoxMessageSender {
  id: string;
  full_name: string;
  picture_url?: string;
}

export interface AimfoxMessage {
  id?: string;
  urn?: string;
  message_id?: string;
  body: string | null;
  sender: AimfoxMessageSender;
  created_at: number;
  automated?: boolean;
  edited?: boolean;
  deleted?: boolean;
}

export interface AimfoxConversationParticipant {
  id: string;
  urn?: string;
  public_identifier?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  picture_url?: string;
  location?: { name: string; urn?: string } | null;
  occupation?: string;
  is_lead?: boolean;
  lead_of?: string[];
  labels?: unknown[];
  favorite?: boolean;
}

export interface AimfoxConversationListItem {
  unread_count: number;
  connected: boolean;
  last_activity_at: number | null;
  conversation_urn: string;
  last_message: AimfoxMessage | null;
  participants: AimfoxConversationParticipant[];
  owner: unknown;
  source: string;
}

export interface AimfoxConversation {
  status: string;
  messages: AimfoxMessage[];
}

export interface AimfoxClientOptions {
  accountId?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  retryBaseMs?: number;
  /** Requests per minute across every client sharing this API key (Aimfox allows 60). */
  maxRpm?: number;
}

export class AimfoxError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AimfoxError";
  }
}

export class AimfoxClient {
  private readonly accountId?: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly maxRpm: number;
  private readonly quotaIdentity: string;

  constructor(
    private readonly apiKey: string,
    options: AimfoxClientOptions = {},
  ) {
    this.accountId = options.accountId;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.maxRpm = options.maxRpm ?? DEFAULT_MAX_RPM;
    this.quotaIdentity = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  }

  private async request<T>(path: string, options?: RequestInit, attempt = 1): Promise<T> {
    await acquireRpmSlot(`aimfox:${this.quotaIdentity}`, { maxRpm: this.maxRpm, sleep: this.sleep });
    const response = await this.fetchFn(`${AIMFOX_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if ((response.status === 429 || response.status >= 500) && attempt < this.maxAttempts) {
      await this.sleep(this.retryDelayMs(response, attempt));
      return this.request<T>(path, options, attempt + 1);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new AimfoxError(response.status, `Aimfox API error (${response.status}): ${summarizeBody(body)}`);
    }

    return response.json() as Promise<T>;
  }

  private retryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const dateMs = new Date(retryAfter).getTime();
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
    }
    return this.retryBaseMs * 2 ** (attempt - 1);
  }

  private requireAccountId(): string {
    if (!this.accountId) throw new Error("Aimfox account id is required for this API call");
    return this.accountId;
  }

  async listAccounts(): Promise<AimfoxAccount[]> {
    const result = await this.request<{ status: string; accounts: AimfoxAccount[] }>("/accounts");
    return result.accounts;
  }

  async getLead(leadId: string): Promise<AimfoxLead> {
    const result = await this.request<{ status: string; lead: AimfoxLead }>(`/leads/${encodeURIComponent(leadId)}`);
    return result.lead;
  }

  async searchLeads(
    start: number,
    count: number,
    filters?: { keywords?: string; labels?: string[]; locations?: string[]; skills?: string[] },
  ): Promise<AimfoxSearchResult> {
    return this.request<AimfoxSearchResult>(`/leads:search?start=${start}&count=${count}`, {
      method: "POST",
      body: JSON.stringify({
        keywords: filters?.keywords ?? "",
        current_companies: [],
        past_companies: [],
        education: [],
        interests: [],
        labels: filters?.labels ?? [],
        languages: [],
        locations: filters?.locations ?? [],
        origins: [],
        skills: filters?.skills ?? [],
        lead_of: [],
        optimize: false,
      }),
    });
  }

  async getRecentLeads(): Promise<AimfoxRecentLead[]> {
    const result = await this.request<{ status: string; leads: AimfoxRecentLead[] }>("/analytics/recent-leads");
    return result.leads;
  }

  /**
   * One page of the workspace inbox, newest-first, strictly older than
   * `before` (ms epoch). Probed 2026-09-04: the default page is 15, `count`
   * is honoured up to 100, and `in_app` — with either value — restricts the
   * result to a 440-thread subset of a 1,720-thread inbox and hides the
   * newest months, so it is deliberately never sent.
   */
  async listConversationsPage(input: { before: number; count: number }): Promise<AimfoxConversationListItem[]> {
    const accountId = this.requireAccountId();
    const count = Math.max(1, Math.min(MAX_CONVERSATION_PAGE, Math.floor(input.count)));
    const params = new URLSearchParams({ before: String(Math.floor(input.before)), count: String(count) });
    const result = await this.request<{ status: string; conversations: AimfoxConversationListItem[] }>(
      `/conversations?${params.toString()}`,
    );
    return result.conversations.filter((conversation) => conversationOwnerId(conversation.owner) === accountId);
  }

  async getConversationUrn(leadId: string): Promise<string | null> {
    const accountId = this.requireAccountId();
    const result = await this.request<{ status: string; urn: string | null }>(
      `/accounts/${encodeURIComponent(accountId)}/leads/${encodeURIComponent(leadId)}/conversation`,
    );
    return result.urn;
  }

  async getConversation(conversationUrn: string): Promise<AimfoxConversation> {
    const accountId = this.requireAccountId();
    return this.request<AimfoxConversation>(
      `/accounts/${encodeURIComponent(accountId)}/conversations/${encodeURIComponent(conversationUrn)}`,
    );
  }
}

function conversationOwnerId(owner: unknown): string | null {
  if (typeof owner === "string" || typeof owner === "number") return String(owner);
  if (owner && typeof owner === "object" && "id" in owner) {
    const id = (owner as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return null;
}

function summarizeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "empty response body";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}
