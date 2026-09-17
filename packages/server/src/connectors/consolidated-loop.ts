import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { createExtractionStageRepository } from "../db/repositories/extraction-stages";
import type { DB } from "../db/schema";
import { coerceMentionType, normalizeMentionType } from "../entities/graph";
import { entitySummaryView, pairwiseEvidenceView } from "../entities/judge-views";
import { buildReadOnlyMatchDeps } from "../entities/materialize-deps";
import { normalizeEntityMatchName } from "../entities/name-keys";
import {
  type MatchCandidate,
  type MatchDecision,
  type MatchDecisionDeps,
  type MatchInput,
  type ProposeEntityType,
  decideEntityMatch,
} from "../entities/propose";
import type { KnownEntityForPrompt } from "./file-scope-context";
import type { GenerateMeta } from "./gemini-generate";
import type { AgenticOptions, AgenticOutcome, AgenticTool, AgenticToolStep } from "./openrouter-generate";
import {
  type ExtractedRelation,
  type ExtractionOrgContext,
  type FileContext,
  MAX_CONTENT_CHARS,
  extractionValidTypes,
} from "./smart-enrichment";

export const CONSOLIDATED_EXTRACTOR_VERSION = "loop-v2";

export interface ConsolidatedLoopAgenticGenerator {
  generateAgenticJSON<T>(prompt: string, opts: AgenticOptions): Promise<AgenticOutcome<T>>;
}

export interface ConsolidatedLoopShadowDeps {
  db: Kysely<DB>;
  logger: Logger;
  agenticGenerator: ConsolidatedLoopAgenticGenerator;
  orgContext?: ExtractionOrgContext | null;
  knownEntities?: KnownEntityForPrompt[];
  participantBlock?: string;
  personCandidateBlock?: string;
  threadContext?: string | null;
  recordLlmUsage?: (context: string, meta: GenerateMeta) => void;
  now?: () => number;
}

export interface ConsolidatedResolutionCandidate {
  entityId: string;
  name: string;
  type?: string;
  rung?: string;
  score?: number;
  note?: string;
}

export type ConsolidatedResolution =
  | { kind: "matched"; entityId: string }
  | { kind: "judged"; entityId: string; reason: string }
  | { kind: "new"; rejectedCandidates?: string[] }
  | { kind: "hold"; reason: string; candidates: ConsolidatedResolutionCandidate[] };

export interface ConsolidatedMention {
  mention: string;
  type: string;
  variations: string[];
  facts: string[];
  resolution: ConsolidatedResolution;
}

export interface ConsolidatedEntityFacts {
  entityId: string;
  facts: string[];
}

export interface ConsolidatedStagedDocument {
  mentions: ConsolidatedMention[];
  relations: ExtractedRelation[];
  entityFacts: ConsolidatedEntityFacts[];
  summary: string;
  meta: {
    toolSteps: Array<Pick<AgenticToolStep, "name" | "durationMs" | "cached">>;
    guard: ConsolidatedLoopGuard;
    registrySize: number;
    model: string;
    validation: {
      droppedMentions: number;
      droppedRelations: number;
      invalidType: number;
      droppedSingleTokenPerson: number;
      schemaInvalid: number;
      droppedSamples: Array<{ mention: string; type: string; reason: string }>;
      malformedResolution: number;
      malformedSamples: Array<{ mention: string; type: string; reason: string }>;
    };
  };
}

export interface ConsolidatedLoopGuard {
  overriddenByMatcher: number;
  demotedUnoffered: number;
  heldUnjudged: number;
  heldPending: number;
  newOverCandidates: number;
  suppressed: number;
  registryLinked: number;
  droppedFacts: number;
  matchToolCalls: number;
  matchToolCalled: boolean;
}

export interface ConsolidatedLoopShadowResult {
  staged: true;
  stageId: string;
  mentionCount: number;
  holdCount: number;
  guard: ConsolidatedLoopGuard;
  meta: GenerateMeta;
}

const candidateSchema = z
  .object({
    entityId: z.string().min(1),
    name: z.string().min(1).optional(),
    type: z.string().optional(),
    rung: z.string().optional(),
    score: z.number().optional(),
    note: z.string().optional(),
  })
  .passthrough()
  .transform((candidate) => ({ ...candidate, name: candidate.name ?? candidate.entityId }));
const resolutionSchema = z.union([
  z.object({ kind: z.literal("matched"), entityId: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("judged"), entityId: z.string().min(1), reason: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("new"), rejectedCandidates: z.array(z.string().min(1)).optional() }).passthrough(),
  z
    .object({
      kind: z.literal("hold"),
      reason: z.string().min(1).default("model_hold"),
      candidates: z.array(candidateSchema).default([]),
    })
    .passthrough(),
]);
const mentionEnvelopeSchema = z
  .object({
    mention: z.string().min(1),
    type: z.string().min(1),
    variations: z.array(z.string()).default([]),
    facts: z.array(z.string().min(1)).default([]),
  })
  .passthrough();
const endpointSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    variations: z.array(z.string()).optional(),
  })
  .passthrough();
const relationSchema = z
  .object({
    type: z.string().min(1),
    source: endpointSchema,
    target: endpointSchema,
    confidence: z.number(),
    context: z.string().optional(),
  })
  .passthrough();
const toolArgs = {
  matchMentions: z
    .object({
      mentions: z.array(z.object({ name: z.string().min(1).max(64), type: z.string().min(1) }).passthrough()),
    })
    .passthrough(),
  entitySummary: z.object({ entityId: z.string().min(1) }).passthrough(),
  pairwiseEvidence: z.object({ entityIds: z.array(z.string().min(1)).min(1) }).passthrough(),
};

function renderKnownHint(entity: KnownEntityForPrompt, index: number): string {
  const parts = [`- [K${index + 1}] ${entity.name} (${entity.type})`];
  if (entity.description) parts.push(` - ${entity.description}`);
  const tags: string[] = [];
  if (typeof entity.mentionCount === "number" && entity.mentionCount > 0)
    tags.push(`${entity.mentionCount} recent files`);
  if (entity.recentlyActive) tags.push("active in last 2 weeks");
  if (tags.length > 0) parts.push(` (${tags.join("; ")})`);
  return parts.join("");
}

interface OfferedMatch {
  status: MatchDecision["status"];
  entityId?: string;
  candidateIds: Set<string>;
  complete: boolean;
}

interface MatchToolResult {
  key: string;
  name: string;
  type: string;
  status: MatchDecision["status"];
  entityId?: string;
  entityName?: string;
  rung?: string;
  candidates?: MatchCandidate[];
  candidateCount?: number;
  candidatesTruncated?: boolean;
  reason?: string;
}

interface RegistryLinkedDecision {
  status: "linked";
  entityId: string;
  entityName: string;
  entityType: "product" | "project";
  rung: "registry";
}

type LoopMatchDecision = MatchDecision | RegistryLinkedDecision;

function isRegistryLinkedDecision(decision: LoopMatchDecision): decision is RegistryLinkedDecision {
  return decision.status === "linked" && !("link" in decision);
}

function canonicalMentionType(name: string, type: string): ProposeEntityType | null {
  return normalizeMentionType(coerceMentionType(name, type));
}

function registryDecision(
  knownEntities: KnownEntityForPrompt[] | undefined,
  name: string,
  type: ProposeEntityType,
): RegistryLinkedDecision | null {
  if (type !== "product" && type !== "project") return null;
  const normalized = normalizeEntityMatchName(type, name);
  for (const entity of knownEntities ?? []) {
    const entityId = entity.entityId ?? entity.id;
    if (!entityId || canonicalMentionType(entity.name, entity.type) !== type) continue;
    const knownNames = [entity.name, ...(entity.aliases ?? [])];
    if (!knownNames.some((knownName) => normalizeEntityMatchName(type, knownName) === normalized)) continue;
    return { status: "linked", entityId, entityName: entity.name, entityType: type, rung: "registry" };
  }
  return null;
}

function mentionKey(name: string, type: ProposeEntityType): string {
  return `${normalizeEntityMatchName(type, name)}\t${type}`;
}

function matchInput(file: FileContext, name: string, type: ProposeEntityType): MatchInput {
  const key = mentionKey(name, type);
  return {
    name,
    entityType: type,
    source: "consolidated_loop",
    sourceId: `${file.id}:${key}`,
    subtype: "external",
    evidence: [],
    triggeredByUserId: "consolidated_loop",
  };
}

async function decideLoopMention(
  deps: MatchDecisionDeps,
  file: FileContext,
  knownEntities: KnownEntityForPrompt[] | undefined,
  name: string,
  type: ProposeEntityType,
): Promise<LoopMatchDecision> {
  return registryDecision(knownEntities, name, type) ?? decideEntityMatch(deps, matchInput(file, name, type));
}

async function matchToolResult(
  deps: MatchDecisionDeps,
  file: FileContext,
  knownEntities: KnownEntityForPrompt[] | undefined,
  name: string,
  type: ProposeEntityType,
): Promise<MatchToolResult> {
  const decision = await decideLoopMention(deps, file, knownEntities, name, type);
  const base = { key: mentionKey(name, type), name, type, status: decision.status };
  if (decision.status === "linked") {
    const entityName = isRegistryLinkedDecision(decision)
      ? decision.entityName
      : (await deps.readEntity?.(decision.entityId))?.name;
    return {
      ...base,
      entityId: decision.entityId,
      entityName,
      rung: decision.rung,
    };
  }
  if (decision.status === "ambiguous" || decision.status === "pending") {
    const candidates = decision.candidates.slice(0, 3);
    return {
      ...base,
      candidates,
      candidateCount: decision.candidates.length,
      candidatesTruncated: candidates.length < decision.candidates.length,
      ...(decision.status === "ambiguous" ? { reason: decision.reason } : { reason: "pending_proposal" }),
    };
  }
  return decision.status === "suppressed" ? { ...base, reason: decision.reason } : base;
}

function serializeMatchResults(results: MatchToolResult[]): string {
  let serialized = JSON.stringify({ results });
  while (serialized.length > 1900) {
    const result = [...results].reverse().find((row) => (row.candidates?.length ?? 0) > 0);
    if (!result?.candidates) break;
    result.candidates.pop();
    result.candidatesTruncated = true;
    serialized = JSON.stringify({ results });
  }
  if (serialized.length > 1900) {
    const compactResults = results.map(
      (result): MatchToolResult => ({
        key: result.key,
        name: result.name,
        type: result.type,
        status: result.status,
        ...(result.entityId === undefined ? {} : { entityId: result.entityId }),
        ...(result.rung === undefined ? {} : { rung: result.rung }),
        ...(result.candidates === undefined ? {} : { candidates: result.candidates }),
        ...(result.candidateCount === undefined ? {} : { candidateCount: result.candidateCount }),
        ...(result.candidatesTruncated === undefined ? {} : { candidatesTruncated: result.candidatesTruncated }),
      }),
    );
    serialized = JSON.stringify({ results: compactResults });
  }
  return serialized;
}

function recordOfferedMatches(serialized: string, offered: Map<string, OfferedMatch>): void {
  const parsed = JSON.parse(serialized) as { results?: MatchToolResult[] };
  for (const result of parsed.results ?? []) {
    offered.set(result.key, {
      status: result.status,
      entityId: result.entityId,
      candidateIds: new Set((result.candidates ?? []).map((candidate) => candidate.entityId)),
      complete: result.candidatesTruncated !== true,
    });
  }
}

async function viewTool<T extends z.ZodType>(
  name: string,
  schema: T,
  args: unknown,
  run: (input: z.infer<T>) => Promise<string>,
): Promise<string> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) return JSON.stringify({ error: `${name}_invalid_args` });
  return run(parsed.data);
}

function buildTools(
  db: Kysely<DB>,
  file: FileContext,
  matchDeps: MatchDecisionDeps,
  knownEntities: KnownEntityForPrompt[] | undefined,
  offered: Map<string, OfferedMatch>,
): AgenticTool[] {
  const validTypes = extractionValidTypes(file.fileType);
  return [
    {
      name: "match_mentions",
      description:
        "Match up to six proposed mentions against the graph. Call repeatedly until every mention has a result.",
      parameters: {
        type: "object",
        properties: {
          mentions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", maxLength: 64 },
                type: { type: "string", enum: [...validTypes] },
              },
              required: ["name", "type"],
            },
          },
        },
        required: ["mentions"],
      },
      run: async (args) => {
        const parsed = toolArgs.matchMentions.safeParse(args);
        if (!parsed.success) return JSON.stringify({ error: "match_mentions_invalid_args" });
        if (parsed.data.mentions.length > 6) {
          return JSON.stringify({
            error: "batch_too_large",
            maxMentions: 6,
            received: parsed.data.mentions.length,
          });
        }
        const results: MatchToolResult[] = [];
        for (const mention of parsed.data.mentions) {
          const type = canonicalMentionType(mention.name, mention.type);
          if (!type || !validTypes.has(type)) {
            const rawType = mention.type.trim().toLowerCase();
            results.push({
              key: `${normalizeEntityMatchName(rawType, mention.name)}\t${rawType}`,
              name: mention.name,
              type: rawType,
              status: "suppressed",
              reason: "invalid_type",
            });
            continue;
          }
          results.push(await matchToolResult(matchDeps, file, knownEntities, mention.name, type));
        }
        const serialized = serializeMatchResults(results);
        recordOfferedMatches(serialized, offered);
        return serialized;
      },
    },
    {
      name: "entity_summary",
      description: "Fetch a compact summary of one candidate entity by id.",
      parameters: {
        type: "object",
        properties: {
          entityId: { type: "string" },
        },
        required: ["entityId"],
      },
      run: (args) =>
        viewTool("entity_summary", toolArgs.entitySummary, args, (input) => entitySummaryView(db, input.entityId)),
    },
    {
      name: "pairwise_evidence",
      description: "Fetch compact shared evidence among up to five entity ids.",
      parameters: {
        type: "object",
        properties: {
          entityIds: { type: "array", items: { type: "string" } },
        },
        required: ["entityIds"],
      },
      run: (args) =>
        viewTool("pairwise_evidence", toolArgs.pairwiseEvidence, args, (input) =>
          pairwiseEvidenceView(db, input.entityIds),
        ),
    },
  ];
}

function buildPrompt(deps: ConsolidatedLoopShadowDeps, file: FileContext): string {
  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);
  const orgSection = deps.orgContext?.description
    ? `\nBackground on the organization that operates this system (${deps.orgContext.orgName ?? "Unknown"}${deps.orgContext.industry ? `, industry: ${deps.orgContext.industry}` : ""}). This is context for disambiguation only. Extract the organization's own products, projects, and people when the document content itself refers to them, including in a speaker line, as an assignee, in an issue header, or as the product being changed. Do not extract entities that appear only in this background text:\n${deps.orgContext.description}\n`
    : "";
  const disambiguationSection = deps.orgContext?.disambiguationGuidance
    ? `\nProduct/disambiguation guidance:\n${deps.orgContext.disambiguationGuidance}\n`
    : "";
  const knownSection =
    deps.knownEntities && deps.knownEntities.length > 0
      ? `\nKnown entities likely to appear in this file are extraction hints only. They carry no id authority: every emitted mention still goes through match_mentions. Known entries have no ids here; to resolve one you must still send it through match_mentions and copy the id from that result. When the document content refers to one of these entities, emit a mention for it using the known name and prefer it as a relationship endpoint. Product entries here are the injected known-products list; use the known name instead of inventing a product name.\n${deps.knownEntities.map(renderKnownHint).join("\n")}\n`
      : "";
  const participantSection = deps.participantBlock && deps.participantBlock.length > 0 ? deps.participantBlock : "";
  const personCandidateSection =
    deps.personCandidateBlock && deps.personCandidateBlock.length > 0 ? deps.personCandidateBlock : "";
  const threadContext = deps.threadContext ?? file.threadContext;
  const threadSection = threadContext
    ? `\nEmail thread context for resolving references only. Do not emit entities, relationships, or facts that appear only in this context; emitted output must be supported by the current message content below.\n${threadContext}\n`
    : "";
  const allowedTypes = [...extractionValidTypes(file.fileType)].filter((type) => type !== "team");
  const validTypesPrompt = allowedTypes.map((type) => `"${type}"`).join(", ");
  const relationshipTypesPrompt = `Valid relationship types:
- "works_at": person -> company (the person is employed by the company)
- "engaged_with": person -> company (the person is working with, for, or delivered to an external company without being employed by it - vendor, consultancy, or client-engagement context)
- "leads": person -> project | product
- "contributes_to": person -> project | product
- "builds": company -> product
- "part_of": project -> project, project -> product, product -> product
- "engagement_for": project -> company (the project is a client engagement delivered for that company)
- "partner_of": company -> company`;

  return `You are analyzing a document to identify meaningful business entities, resolve them, extract supported relationships, extract per-entity facts, and write a search-index summary in one JSON document.
${orgSection}${disambiguationSection}${knownSection}${personCandidateSection}${participantSection}${threadSection}
File: ${file.fileName}
File id: ${file.id}
Source: ${file.source}${file.sourcePath ? ` / ${file.sourcePath}` : ""}
Type: ${file.contentCategory}
Date: ${file.sourceCreatedAt || file.sourceUpdatedAt || "unknown"}

Extract entities that a business team would want to track and reference across documents. Focus on:
- **People**: named individuals (employees, clients, contacts)
- **Companies**: external businesses, clients, partners, vendors
- **Products**: named products or services your org or your client builds or owns. When product entries appear in the Known entities section, treat that injected known-products list as the source of truth instead of inventing product names.
- **Projects**: named umbrella engagements or programs with their own scope and timeline (e.g., "OW Tourism Dashboard", "Paid Member Migration Phase 2", "K8S Migration"). A project is the umbrella, NOT a single ticket, pull request, or one feature of a product.
- **Tools**: third-party SaaS apps/platforms the org uses (e.g., Slack, Notion, Zoom, Figma, GitHub)

DO NOT extract:
- Email addresses, phone numbers, URLs, or other system identifiers - these are stored separately. If a person is identifiable by name, use the name (e.g., "Sarah Chen"); never use an email address as the mention.
- Generic technologies, frameworks, or libraries (Redis, Kafka, Node.js, React, PostgreSQL, Express, Vite)
- Cloud infrastructure services (ECS, EKS, RDS, S3, Lambda, AWS Batch)
- Programming concepts or acronyms (LLM, NLP, API, SDK, REST, GraphQL, npm)
- Operating systems or platforms as entities (iOS, Android, Linux)
- Backlog lists, sprint names, or task board columns ("[Infra] Backlog", "Sprint 5", "Exp Sprint 2")
- Microservice names (auth-service, user-service, payment-service)
- Generic categories (SEO, Marketing, Support, Content)
- Countries, currencies, or generic locations (India, INR, US)
- File formats, protocols, or standards (JSON, HTTP, WebSocket)
- Meeting titles or calendar event names - anything containing "<>", "Standup", "Sync", "Weekly", "Daily", or "1:1". These are calendar event names, not projects. Extract the companies and people referenced by the meeting instead.
- Document, note, or artifact titles as projects (e.g. names ending in "note", "chart", "doc", "spec", "deck"). These are filenames, not engagements.
- Issue or ticket identifiers and keys - "SKE-123", "ECR-01", "ABC-1234", or a bare "#192". These are individual work items, not projects; extract the project or product they belong to instead, never the ticket key (even when the key is followed by a title, e.g. "SKE-120: Provenance columns").
- Pull requests, commits, or branches - "PR #192", commit SHAs, branch names. These are code artifacts, not engagements.
- A single feature, tab, screen, or module of a product as a project - "Files", "Workflows", "Analytics", "Push Notifications", "Outlook Integration". These are parts of a product, not umbrella engagements with their own scope.
- Generic feature descriptions or internal component names as products (e.g. "responder functionality", "conversational model", "X service", "X module", "X pipeline"). Products must be a branded, proper-noun name your org or a client publicly markets - not the internal name of a component you are building.
- Capability areas, risk/compliance domains, and meeting-agenda headings are NOT projects - e.g. "Cloud", "Data & AI", "AML", "Fraud", "Risk", "Compliance", "Vendor Strategy", "Stakeholder Alignment", "RFP follow-ups".
- Meeting section titles, status notes, activity descriptions, metrics, generic verbs, or generic technical nouns
- Task fragments or implementation notes with no stable named project/product parent, such as "Vedant's Project Progress", "67 SQL queries on the new database", "limitation note", "UI development", "backend work", or "new database"

Name shape rules (person mentions only):
- Person mentions must be Title Case with a recognizable first + last name separated by whitespace (e.g., "Sarah Chen", "Ashish Banka"). Reject and omit:
  - Single first names with no surname or other identifier ("Sarah", "Mohammed", "Manish")
  - Initials-only strings ("KT", "P C", "SB", "VD")
  - Email-handle style strings - no spaces, lowercase, or otherwise looks like an email local part ("bhavyasharma", "nancyjain", "ayushgupta")
  - ALL-CAPS strings ("ASHISH BANKA", "RAJ BHOSLE")
  - Whitespace-only or non-printing strings
- When the source uses one of these degraded forms, omit the mention rather than emit the degraded version. If you can recover the proper-name form in Title Case with high confidence from surrounding context, emit the recovered form.

Type disambiguation:
- Any mention ending in "Pvt Ltd", "Private Limited", "Inc", "LLC", "Ltd", "GmbH", "Consulting", "Solutions", or "Technologies" is type "company", never "person", regardless of where it appears (including the participant block).
- Third-party data sources, market-data providers, and SaaS you merely integrate with or pull data from are type "tool", not "product"; e.g. a flight/hotel/market-data API or provider you consume is a tool.

If email thread context is provided, use it only to resolve references in the current message. Do not extract an entity or relationship unless the current message refers to it directly or indirectly.

Most relationships in a business corpus follow this hierarchy, top down: **Companies** (clients, partners, vendors) own engagements -> **Projects** are named umbrella engagements with a defined scope -> **Products** are named offerings or tools -> **People** work on those projects and products, either internally for their own team or on behalf of a client engagement. Prefer extracting from the top down.

Also extract direct relationships only when the text explicitly supports them.

${relationshipTypesPrompt}

Use "engaged_with" (not "works_at") whenever the person's employer is a different company from the one named on the right. Example: a Canvas engineer meeting with Oliver Wyman is engaged_with Oliver Wyman, not works_at Oliver Wyman.
Use "engagement_for" for a PROJECT delivered for a client company; use "engaged_with" for a PERSON working with a company.
Do not extract "member_of", "deal_for", or "primary_contact" from prose; those are connector-sourced relationships.

When a "Meeting participants" block is present above and lists attendees from multiple companies, the cross-company link is itself relationship evidence even when the prose never names the external company. Emit \`engaged_with\` edges from home-company participants who are marked \`[action-item owner]\` to each external company present in the participants block. Treat silent external attendees (no action items) with caution - only emit when the prose corroborates it. Use the participant name and the external company name exactly as they appear in the block as the relation endpoints.

Resolution workflow:
1. First make the mention list complete: list every qualifying mention with its canonical type and mention-scoped facts. Never omit a qualifying mention to reduce the number of match_mentions batches.
2. Call match_mentions in batches of at most six until every mention has a result. Repeat across tool rounds as needed.
3. For ambiguous results, use entity_summary and pairwise_evidence as needed, then judge only among candidates match_mentions actually returned.
4. Write the final JSON document.

Resolution rules:
- Copy ids only from match_mentions results. Never use an id from memory or from the Known entities hints.
- A linked result becomes { "kind": "matched", "entityId": "<linked id>" }.
- For an ambiguous result, select one visible candidate with { "kind": "judged", "entityId": "<candidate id>", "reason": "<short evidence-based reason>" }.
- Use { "kind": "new" } only when match_mentions said new.
- To reject every candidate from an ambiguous result as genuinely new, match_mentions must say candidatesTruncated is false and resolution must be { "kind": "new", "rejectedCandidates": ["<every returned candidate id>"] }.
- An ambiguous result you cannot settle and a pending result both use { "kind": "hold", "reason": "<short reason>", "candidates": [{ "entityId": "<candidate id>", "name": "<candidate name>", "type": "<candidate type>", "rung": "<candidate rung>", "score": 0.0 }] }. Copy the candidate objects exactly as match_mentions returned them, or use "candidates": [] when it returned none. An id beginning with "review:" stays in candidates and is never used as the resolution's entityId.
- Facts belong inside the mention they describe.

Write a 2-3 sentence summary focusing on: what this document is about, key decisions or outcomes, and topics discussed. Be specific - use names, numbers, dates. Do not start with "This document".

Return exactly one JSON object with this shape:
{
  "mentions": [
    {
      "mention": "Sarah Chen",
      "type": "person",
      "variations": ["Sarah", "S. Chen"],
      "facts": ["Sarah Chen leads Project Atlas"],
      "resolution": { "kind": "matched", "entityId": "ent_123" }
    },
    {
      "mention": "Sarah Cheng",
      "type": "person",
      "variations": [],
      "facts": ["Sarah Cheng attended the meeting"],
      "resolution": {
        "kind": "hold",
        "reason": "ambiguous person",
        "candidates": [{ "entityId": "ent_456", "name": "Sarah Chen", "type": "person" }]
      }
    }
  ],
  "relations": [
    {
      "type": "leads",
      "source": { "name": "Sarah Chen", "type": "person", "variations": ["Sarah"] },
      "target": { "name": "Project Atlas", "type": "project", "variations": ["Atlas"] },
      "confidence": 0.92,
      "context": "Sarah Chen leads Project Atlas"
    }
  ],
  "summary": "2-3 sentence summary here."
}

Valid types: ${validTypesPrompt}

If no notable entities, relations, or facts are found, return { "mentions": [], "relations": [], "summary": "<2-3 sentence summary>" }.

<content>
${truncatedContent}
</content>`;
}

interface ValidatedDocument {
  mentions: ConsolidatedMention[];
  relations: ExtractedRelation[];
  summary: string;
  droppedKeys: Set<string>;
  droppedFacts: number;
  validation: ConsolidatedStagedDocument["meta"]["validation"];
}

function appendUnique(target: string[], values: string[]): void {
  const seen = new Set(target);
  for (const value of values) {
    if (!seen.has(value)) {
      target.push(value);
      seen.add(value);
    }
  }
}

function resolutionCandidates(resolution: ConsolidatedResolution): ConsolidatedResolutionCandidate[] {
  if (resolution.kind === "hold") return resolution.candidates;
  if (resolution.kind === "matched" || resolution.kind === "judged") {
    return [{ entityId: resolution.entityId, name: resolution.entityId }];
  }
  return (resolution.rejectedCandidates ?? []).map((entityId) => ({ entityId, name: entityId }));
}

function mergeCandidates(
  left: ConsolidatedResolutionCandidate[],
  right: ConsolidatedResolutionCandidate[],
): ConsolidatedResolutionCandidate[] {
  const byId = new Map<string, ConsolidatedResolutionCandidate>();
  for (const candidate of [...left, ...right]) {
    if (!byId.has(candidate.entityId)) byId.set(candidate.entityId, candidate);
  }
  return [...byId.values()];
}

function rawMentionKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.mention !== "string" || typeof record.type !== "string") return null;
  const type = canonicalMentionType(record.mention, record.type);
  return type ? mentionKey(record.mention, type) : null;
}

function rawFactsCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const facts = (value as Record<string, unknown>).facts;
  return Array.isArray(facts) ? facts.filter((fact) => typeof fact === "string" && fact.length > 0).length : 0;
}

function addDroppedSample(
  samples: Array<{ mention: string; type: string; reason: string }>,
  value: unknown,
  reason: string,
): void {
  if (samples.length >= 5) return;
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  samples.push({
    mention: typeof record.mention === "string" ? record.mention : "?",
    type: typeof record.type === "string" ? record.type : "?",
    reason,
  });
}

function validateDocument(raw: unknown, file: FileContext): ValidatedDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("consolidated loop response must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.mentions)) throw new Error("consolidated loop response missing mentions");
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) {
    throw new Error("consolidated loop response missing summary");
  }

  const validTypes = extractionValidTypes(file.fileType);
  const byKey = new Map<string, ConsolidatedMention>();
  const droppedKeys = new Set<string>();
  let droppedMentions = 0;
  let invalidType = 0;
  let schemaInvalid = 0;
  let malformedResolution = 0;
  let droppedFacts = 0;
  const droppedSamples: Array<{ mention: string; type: string; reason: string }> = [];
  const malformedSamples: Array<{ mention: string; type: string; reason: string }> = [];
  for (const row of record.mentions) {
    const parsedEnvelope = mentionEnvelopeSchema.safeParse(row);
    if (!parsedEnvelope.success) {
      droppedMentions += 1;
      schemaInvalid += 1;
      droppedFacts += rawFactsCount(row);
      addDroppedSample(droppedSamples, row, parsedEnvelope.error.issues[0]?.path.join(".") || "?");
      const key = rawMentionKey(row);
      if (key) droppedKeys.add(key);
      continue;
    }
    const type = canonicalMentionType(parsedEnvelope.data.mention, parsedEnvelope.data.type);
    if (!type || !validTypes.has(type)) {
      droppedMentions += 1;
      invalidType += 1;
      droppedFacts += parsedEnvelope.data.facts.length;
      addDroppedSample(droppedSamples, row, "invalid_type");
      if (type) droppedKeys.add(mentionKey(parsedEnvelope.data.mention, type));
      continue;
    }
    const rawResolution =
      row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>).resolution : undefined;
    const parsedResolution = resolutionSchema.safeParse(rawResolution);
    const resolution: ConsolidatedResolution = parsedResolution.success
      ? parsedResolution.data
      : { kind: "hold", reason: "malformed_resolution", candidates: [] };
    if (!parsedResolution.success) {
      malformedResolution += 1;
      addDroppedSample(malformedSamples, row, parsedResolution.error.issues[0]?.path.join(".") || "?");
    }
    const key = mentionKey(parsedEnvelope.data.mention, type);
    const mention: ConsolidatedMention = { ...parsedEnvelope.data, type, resolution };
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, mention);
      continue;
    }
    appendUnique(existing.variations, mention.variations);
    appendUnique(existing.facts, mention.facts);
    if (JSON.stringify(existing.resolution) !== JSON.stringify(mention.resolution)) {
      existing.resolution = {
        kind: "hold",
        reason: "key_collision",
        candidates: mergeCandidates(
          resolutionCandidates(existing.resolution),
          resolutionCandidates(mention.resolution),
        ),
      };
    }
  }

  const relationRows = Array.isArray(record.relations) ? record.relations : [];
  const relations: ExtractedRelation[] = [];
  let droppedRelations = 0;
  for (const row of relationRows) {
    const parsed = relationSchema.safeParse(row);
    if (!parsed.success) {
      droppedRelations += 1;
      continue;
    }
    const sourceType = canonicalMentionType(parsed.data.source.name, parsed.data.source.type);
    const targetType = canonicalMentionType(parsed.data.target.name, parsed.data.target.type);
    if (!sourceType || !targetType || !validTypes.has(sourceType) || !validTypes.has(targetType)) {
      droppedRelations += 1;
      continue;
    }
    relations.push({
      ...parsed.data,
      source: { ...parsed.data.source, type: sourceType },
      target: { ...parsed.data.target, type: targetType },
    });
  }

  return {
    mentions: [...byKey.values()],
    relations,
    summary: record.summary.trim(),
    droppedKeys,
    droppedFacts,
    validation: {
      droppedMentions,
      droppedRelations,
      invalidType,
      droppedSingleTokenPerson: 0,
      schemaInvalid,
      droppedSamples,
      malformedResolution,
      malformedSamples,
    },
  };
}

function decisionCandidates(decision: LoopMatchDecision): ConsolidatedResolutionCandidate[] {
  if (decision.status !== "ambiguous" && decision.status !== "pending") return [];
  return decision.candidates.map((candidate) => ({
    entityId: candidate.entityId,
    name: candidate.name,
    type: candidate.type,
    rung: candidate.rung,
    score: candidate.score,
  }));
}

async function linkedDecisionCandidates(
  deps: MatchDecisionDeps,
  decision: Extract<LoopMatchDecision, { status: "linked" }>,
): Promise<ConsolidatedResolutionCandidate[]> {
  if (isRegistryLinkedDecision(decision)) {
    return [{ entityId: decision.entityId, name: decision.entityName, type: decision.entityType, rung: decision.rung }];
  }
  const entity = await deps.readEntity?.(decision.entityId);
  return [
    {
      entityId: decision.entityId,
      name: entity?.name ?? decision.entityId,
      type: entity?.source_type,
      rung: decision.rung,
    },
  ];
}

function isSingleTokenPerson(mention: ConsolidatedMention): boolean {
  return mention.type === "person" && mention.mention.trim().length > 0 && !/\s/.test(mention.mention.trim());
}

function acceptedEntityId(resolution: ConsolidatedResolution): string | null {
  return resolution.kind === "matched" || resolution.kind === "judged" ? resolution.entityId : null;
}

async function reconcileDocument(
  validated: ValidatedDocument,
  file: FileContext,
  matchDeps: MatchDecisionDeps,
  knownEntities: KnownEntityForPrompt[] | undefined,
  offered: Map<string, OfferedMatch>,
  matchToolCalls: number,
): Promise<{
  mentions: ConsolidatedMention[];
  relations: ExtractedRelation[];
  entityFacts: ConsolidatedEntityFacts[];
  guard: ConsolidatedLoopGuard;
}> {
  const guard: ConsolidatedLoopGuard = {
    overriddenByMatcher: 0,
    demotedUnoffered: 0,
    heldUnjudged: 0,
    heldPending: 0,
    newOverCandidates: 0,
    suppressed: 0,
    registryLinked: 0,
    droppedFacts: validated.droppedFacts,
    matchToolCalls,
    matchToolCalled: matchToolCalls > 0,
  };
  const mentions: ConsolidatedMention[] = [];
  const droppedKeys = new Set(validated.droppedKeys);
  const factsByEntityId = new Map<string, string[]>();

  for (const mention of validated.mentions) {
    const type = mention.type as ProposeEntityType;
    const key = mentionKey(mention.mention, type);
    const decision = await decideLoopMention(matchDeps, file, knownEntities, mention.mention, type);
    if (isRegistryLinkedDecision(decision)) guard.registryLinked += 1;
    const modelResolution = mention.resolution;
    let resolution: ConsolidatedResolution | null = null;

    if (
      decision.status === "linked" &&
      !isRegistryLinkedDecision(decision) &&
      (decision.link.via === "alias_authoritative" || decision.link.via === "ledger")
    ) {
      resolution = { kind: "matched", entityId: decision.entityId };
      if (modelResolution.kind !== "matched" || modelResolution.entityId !== decision.entityId) {
        guard.overriddenByMatcher += 1;
      }
    } else if (decision.status === "pending") {
      resolution = {
        kind: "hold",
        reason: "pending_proposal",
        candidates: mergeCandidates(
          decisionCandidates(decision),
          decision.reviewIds.map((reviewId) => ({ entityId: `review:${reviewId}`, name: "Pending proposal" })),
        ),
      };
      guard.heldPending += 1;
    } else if (decision.status === "suppressed") {
      droppedKeys.add(key);
      guard.suppressed += 1;
    } else if (isSingleTokenPerson(mention)) {
      if (modelResolution.kind === "new") {
        droppedKeys.add(key);
        validated.validation.droppedMentions += 1;
        validated.validation.droppedSingleTokenPerson += 1;
      } else {
        const candidates =
          decision.status === "linked"
            ? await linkedDecisionCandidates(matchDeps, decision)
            : decisionCandidates(decision);
        resolution = { kind: "hold", reason: "single_token_person", candidates };
      }
    } else if (decision.status === "linked") {
      resolution = { kind: "matched", entityId: decision.entityId };
      if (modelResolution.kind !== "matched" || modelResolution.entityId !== decision.entityId) {
        guard.overriddenByMatcher += 1;
      }
    } else if (decision.status === "ambiguous") {
      const candidates = decisionCandidates(decision);
      const candidateIds = new Set(decision.candidates.map((candidate) => candidate.entityId));
      const offeredMatch = offered.get(key);
      if (modelResolution.kind === "judged") {
        if (
          candidateIds.has(modelResolution.entityId) &&
          offeredMatch?.status === "ambiguous" &&
          offeredMatch.candidateIds.has(modelResolution.entityId)
        ) {
          resolution = modelResolution;
        } else {
          resolution = { kind: "hold", reason: "unoffered_target", candidates };
          guard.demotedUnoffered += 1;
        }
      } else if (modelResolution.kind === "matched") {
        resolution = { kind: "hold", reason: "protocol_matched_on_ambiguous", candidates };
        guard.demotedUnoffered += 1;
      } else if (modelResolution.kind === "new") {
        const rejected = new Set(modelResolution.rejectedCandidates ?? []);
        const rejectedEveryOffered =
          offeredMatch?.status === "ambiguous" &&
          offeredMatch.complete &&
          [...offeredMatch.candidateIds].every((entityId) => rejected.has(entityId));
        if (rejectedEveryOffered) {
          resolution = { kind: "new", rejectedCandidates: [...(modelResolution.rejectedCandidates ?? [])] };
          guard.newOverCandidates += 1;
        } else {
          resolution = { kind: "hold", reason: "unjudged_candidates", candidates };
          guard.heldUnjudged += 1;
        }
      } else {
        resolution = {
          kind: "hold",
          reason: modelResolution.reason,
          candidates: mergeCandidates(modelResolution.candidates, candidates),
        };
      }
    } else if (modelResolution.kind === "matched" || modelResolution.kind === "judged") {
      resolution = { kind: "hold", reason: "unoffered_target", candidates: [] };
      guard.demotedUnoffered += 1;
    } else if (modelResolution.kind === "new") {
      resolution = { kind: "new" };
    } else {
      resolution = modelResolution;
    }

    if (!resolution) {
      guard.droppedFacts += mention.facts.length;
      continue;
    }
    const reconciled = { ...mention, resolution };
    mentions.push(reconciled);
    const entityId = acceptedEntityId(resolution);
    if (!entityId) {
      guard.droppedFacts += mention.facts.length;
      continue;
    }
    const facts = factsByEntityId.get(entityId) ?? [];
    appendUnique(facts, mention.facts);
    factsByEntityId.set(entityId, facts);
  }

  const relations = validated.relations.filter((relation) => {
    const sourceType = relation.source.type as ProposeEntityType;
    const targetType = relation.target.type as ProposeEntityType;
    const dropped =
      droppedKeys.has(mentionKey(relation.source.name, sourceType)) ||
      droppedKeys.has(mentionKey(relation.target.name, targetType));
    if (dropped) validated.validation.droppedRelations += 1;
    return !dropped;
  });
  const entityFacts = [...factsByEntityId].map(([entityId, facts]) => ({ entityId, facts }));
  return { mentions, relations, entityFacts, guard };
}

export async function runConsolidatedLoopShadow(
  deps: ConsolidatedLoopShadowDeps,
  file: FileContext,
): Promise<ConsolidatedLoopShadowResult> {
  const matchDeps = await buildReadOnlyMatchDeps(deps.db);
  const offered = new Map<string, OfferedMatch>();
  const toolSteps: Array<Pick<AgenticToolStep, "name" | "durationMs" | "cached">> = [];
  let matchToolCalls = 0;
  const outcome = await deps.agenticGenerator.generateAgenticJSON<unknown>(buildPrompt(deps, file), {
    maxTokens: 16_384,
    label: `consolidatedLoop:${file.id}`,
    tools: buildTools(deps.db, file, matchDeps, deps.knownEntities, offered),
    maxToolRounds: 4,
    onToolStep: (step) => {
      toolSteps.push({ name: step.name, durationMs: step.durationMs, cached: step.cached });
      if (step.name === "match_mentions") matchToolCalls += 1;
      deps.logger.debug(
        { fileId: file.id, name: step.name, durationMs: step.durationMs },
        "consolidated loop tool step",
      );
    },
  });
  const validated = validateDocument(outcome.value, file);
  const reconciled = await reconcileDocument(validated, file, matchDeps, deps.knownEntities, offered, matchToolCalls);
  if (validated.validation.droppedMentions > 0 || validated.validation.droppedRelations > 0) {
    const { droppedMentions, droppedRelations, invalidType, droppedSingleTokenPerson, schemaInvalid } =
      validated.validation;
    deps.logger.warn(
      { fileId: file.id, droppedMentions, droppedRelations, invalidType, droppedSingleTokenPerson, schemaInvalid },
      "consolidated loop dropped malformed rows",
    );
  }
  const stagedDocument: ConsolidatedStagedDocument = {
    mentions: reconciled.mentions,
    relations: reconciled.relations,
    entityFacts: reconciled.entityFacts,
    summary: validated.summary,
    meta: {
      toolSteps,
      guard: reconciled.guard,
      registrySize: deps.knownEntities?.length ?? 0,
      model: outcome.meta.model,
      validation: validated.validation,
    },
  };
  const stage = await createExtractionStageRepository(deps.db).stageExtraction({
    indexedFileId: file.id,
    contentHash: file.contentHash ?? null,
    extractorVersion: CONSOLIDATED_EXTRACTOR_VERSION,
    stagedJson: JSON.stringify(stagedDocument),
    model: outcome.meta.model,
    rounds: outcome.rounds,
    toolCalls: toolSteps.length,
    inputTokens: outcome.meta.usage?.promptTokens ?? null,
    outputTokens: outcome.meta.usage?.completionTokens ?? null,
    costUsd: outcome.meta.costUsd ?? null,
    durationMs: outcome.meta.durationMs,
  });
  deps.recordLlmUsage?.("enrichment:consolidatedLoop", outcome.meta);
  return {
    staged: true,
    stageId: stage.id,
    mentionCount: stagedDocument.mentions.length,
    holdCount: stagedDocument.mentions.filter((mention) => mention.resolution.kind === "hold").length,
    guard: reconciled.guard,
    meta: outcome.meta,
  };
}
