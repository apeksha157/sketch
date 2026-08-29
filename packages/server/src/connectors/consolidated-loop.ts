import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import { createExtractionStageRepository } from "../db/repositories/extraction-stages";
import type { DB } from "../db/schema";
import { candidateLookupView, entitySummaryView, fileContextView, pairwiseEvidenceView } from "../entities/judge-views";
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

export const CONSOLIDATED_EXTRACTOR_VERSION = "loop-v1";

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

type Resolution =
  | { kind: "known"; entityId: string }
  | { kind: "tool"; entityId: string }
  | { kind: "new" }
  | { kind: "hold"; reason: string; candidates: Array<{ entityId: string; name: string; note: string }> };

export interface ConsolidatedMention {
  mention: string;
  type: string;
  variations: string[];
  resolution: Resolution;
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
      droppedEntityFacts: number;
    };
  };
}

export interface ConsolidatedLoopGuard {
  demotedUnoffered: number;
  droppedFacts: number;
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
    name: z.string().min(1),
    note: z.string().default(""),
  })
  .passthrough();
const resolutionSchema = z.union([
  z.object({ kind: z.literal("known"), entityId: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("tool"), entityId: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal("new") }).passthrough(),
  z.object({ kind: z.literal("hold"), reason: z.string().min(1), candidates: z.array(candidateSchema) }).passthrough(),
]);
const mentionSchema = z
  .object({
    mention: z.string().min(1),
    type: z.string().min(1),
    variations: z.array(z.string()).default([]),
    resolution: resolutionSchema,
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
const entityFactSchema = z
  .object({
    entityId: z.string().min(1),
    facts: z.array(z.string().min(1)),
  })
  .passthrough();
const toolArgs = {
  lookupCandidates: z.object({ name: z.string().min(1), entityType: z.string().min(1) }).passthrough(),
  entitySummary: z.object({ entityId: z.string().min(1) }).passthrough(),
  pairwiseEvidence: z.object({ entityIds: z.array(z.string().min(1)).min(1) }).passthrough(),
  fileContext: z.object({ fileId: z.string().min(1) }).passthrough(),
};

function renderKnownWithIds(entity: KnownEntityForPrompt, index: number): string {
  const authority = entity.entityId ?? (entity.reviewId ? `review:${entity.reviewId}` : (entity.id ?? "unresolved"));
  const parts = [`- [K${index + 1}] ${entity.name} (${entity.type}) id=${authority}`];
  if (entity.description) parts.push(` - ${entity.description}`);
  const tags: string[] = [];
  if (typeof entity.mentionCount === "number" && entity.mentionCount > 0)
    tags.push(`${entity.mentionCount} recent files`);
  if (entity.recentlyActive) tags.push("active in last 2 weeks");
  if (tags.length > 0) parts.push(` (${tags.join("; ")})`);
  return parts.join("");
}

function collectOfferedIdsFromJson(result: string, offeredIds: Set<string>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return;
  }

  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "id" || key === "entityId" || key === "otherId") && typeof child === "string") {
        offeredIds.add(child);
      }
      walk(child);
    }
  }

  walk(parsed);
}

async function viewTool<T extends z.ZodType>(
  name: string,
  schema: T,
  args: unknown,
  run: (input: z.infer<T>) => Promise<string>,
  offeredIds: Set<string>,
): Promise<string> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) return JSON.stringify({ error: `${name}_invalid_args` });
  const result = await run(parsed.data);
  collectOfferedIdsFromJson(result, offeredIds);
  return result;
}

function buildTools(db: Kysely<DB>, fileId: string, offeredIds: Set<string>): AgenticTool[] {
  return [
    {
      name: "lookup_candidates",
      description:
        "Look up candidate entities by mention name and entity type. Returns entity ids that may be used for tool resolutions or hold candidates.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          entityType: { type: "string" },
        },
        required: ["name", "entityType"],
      },
      run: (args) =>
        viewTool(
          "lookup_candidates",
          toolArgs.lookupCandidates,
          args,
          (input) => candidateLookupView(db, input),
          offeredIds,
        ),
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
        viewTool(
          "entity_summary",
          toolArgs.entitySummary,
          args,
          (input) => entitySummaryView(db, input.entityId),
          offeredIds,
        ),
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
        viewTool(
          "pairwise_evidence",
          toolArgs.pairwiseEvidence,
          args,
          (input) => pairwiseEvidenceView(db, input.entityIds),
          offeredIds,
        ),
    },
    {
      name: "file_context",
      description:
        "Fetch compact graph context already linked to this file. Use the provided file id unless comparing a tool result's nearby evidence.",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string", enum: [fileId] },
        },
        required: ["fileId"],
      },
      run: (args) =>
        viewTool("file_context", toolArgs.fileContext, args, (input) => fileContextView(db, input.fileId), offeredIds),
    },
  ];
}

function buildPrompt(deps: ConsolidatedLoopShadowDeps, file: FileContext): string {
  const truncatedContent = file.content.slice(0, MAX_CONTENT_CHARS);
  const orgSection = deps.orgContext?.description
    ? `\nBackground on the organization that operates this system (${deps.orgContext.orgName ?? "Unknown"}${deps.orgContext.industry ? `, industry: ${deps.orgContext.industry}` : ""}). This is context for disambiguation only - do NOT extract an entity merely because it is named in this background. Extract only entities the document content below actually refers to:\n${deps.orgContext.description}\n`
    : "";
  const disambiguationSection = deps.orgContext?.disambiguationGuidance
    ? `\nProduct/disambiguation guidance:\n${deps.orgContext.disambiguationGuidance}\n`
    : "";
  const knownSection =
    deps.knownEntities && deps.knownEntities.length > 0
      ? `\nKnown entities likely to appear in this file - each has a handle like [K1] and a real id. Match these to mentions instead of creating duplicates, and prefer them as relationship endpoints. Product entries here are the injected known-products list; map product mentions to those entries instead of inventing product names. Do not use tools for confident registry hits. Entries whose id starts with "review:" are pending proposals, not live entities - never use a review: id as a resolution entityId; when a mention matches one, use { "kind": "hold" } and list the review: id in candidates instead.\n${deps.knownEntities.map(renderKnownWithIds).join("\n")}\n`
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

Resolution rules:
- For a confident match to the Known entities registry, set resolution to { "kind": "known", "entityId": "<registry entityId>" }. Do not use tools for registry hits.
- Use tools only for mentions not confidently matched against the registry.
- If a tool result supports a confident existing entity, set resolution to { "kind": "tool", "entityId": "<tool result entity id>" }.
- Every resolution entityId must be copied verbatim from the registry above or from a tool result in this conversation. Never write an entityId from memory or guesswork - people and other entities you recognize but have no id for resolve as "new" (or via lookup_candidates first).
- If you are confident the mention is a new entity, set resolution to { "kind": "new" }.
- If you cannot settle the mention, set resolution to { "kind": "hold", "reason": "<short reason>", "candidates": [{ "entityId": "<candidate id>", "name": "<candidate name>", "note": "<why considered>" }] }. Holds must list the candidates you considered; an empty list is allowed only when lookup returned nothing.

Write a 2-3 sentence summary focusing on: what this document is about, key decisions or outcomes, and topics discussed. Be specific - use names, numbers, dates. Do not start with "This document".

Return exactly one JSON object with this shape:
{
  "mentions": [
    {
      "mention": "Sarah Chen",
      "type": "person",
      "variations": ["Sarah", "S. Chen"],
      "resolution": { "kind": "known", "entityId": "ent_123" }
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
  "entityFacts": [
    { "entityId": "ent_123", "facts": ["Sarah Chen leads Project Atlas"] }
  ],
  "summary": "2-3 sentence summary here."
}

Valid types: ${validTypesPrompt}

If no notable entities, relations, or facts are found, return { "mentions": [], "relations": [], "entityFacts": [], "summary": "<2-3 sentence summary>" }.

<content>
${truncatedContent}
</content>`;
}

function sanitizeRows<T>(rows: unknown, schema: z.ZodType<T>): { values: T[]; dropped: number } {
  if (!Array.isArray(rows)) return { values: [], dropped: 0 };
  const values: T[] = [];
  let dropped = 0;
  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (parsed.success) values.push(parsed.data);
    else dropped += 1;
  }
  return { values, dropped };
}

function validateDocument(raw: unknown): {
  mentions: ConsolidatedMention[];
  relations: ExtractedRelation[];
  entityFacts: ConsolidatedEntityFacts[];
  summary: string;
  validation: ConsolidatedStagedDocument["meta"]["validation"];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("consolidated loop response must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.mentions)) throw new Error("consolidated loop response missing mentions");
  if (typeof record.summary !== "string" || record.summary.trim().length === 0) {
    throw new Error("consolidated loop response missing summary");
  }
  const mentions = sanitizeRows(record.mentions, mentionSchema);
  const relations = sanitizeRows(record.relations, relationSchema);
  const entityFacts = sanitizeRows(record.entityFacts, entityFactSchema);
  return {
    mentions: mentions.values,
    relations: relations.values,
    entityFacts: entityFacts.values,
    summary: record.summary.trim(),
    validation: {
      droppedMentions: mentions.dropped,
      droppedRelations: relations.dropped,
      droppedEntityFacts: entityFacts.dropped,
    },
  };
}

function applyLinkAuthorityGuard(
  doc: Pick<ConsolidatedStagedDocument, "mentions" | "entityFacts">,
  offeredIds: Set<string>,
): ConsolidatedLoopGuard {
  let demotedUnoffered = 0;
  let droppedFacts = 0;
  for (const mention of doc.mentions) {
    if (
      (mention.resolution.kind === "known" || mention.resolution.kind === "tool") &&
      !offeredIds.has(mention.resolution.entityId)
    ) {
      mention.resolution = { kind: "hold", reason: "unoffered_target", candidates: [] };
      demotedUnoffered += 1;
    }
  }
  const retainedFacts = doc.entityFacts.filter((row) => {
    if (offeredIds.has(row.entityId)) return true;
    droppedFacts += 1;
    return false;
  });
  doc.entityFacts.splice(0, doc.entityFacts.length, ...retainedFacts);
  return { demotedUnoffered, droppedFacts };
}

export async function runConsolidatedLoopShadow(
  deps: ConsolidatedLoopShadowDeps,
  file: FileContext,
): Promise<ConsolidatedLoopShadowResult> {
  const offeredIds = new Set<string>();
  for (const entity of deps.knownEntities ?? []) {
    if (entity.entityId) offeredIds.add(entity.entityId);
  }
  const toolSteps: Array<Pick<AgenticToolStep, "name" | "durationMs" | "cached">> = [];
  const outcome = await deps.agenticGenerator.generateAgenticJSON<unknown>(buildPrompt(deps, file), {
    maxTokens: 16_384,
    label: `consolidatedLoop:${file.id}`,
    tools: buildTools(deps.db, file.id, offeredIds),
    maxToolRounds: 6,
    onToolStep: (step) => {
      toolSteps.push({ name: step.name, durationMs: step.durationMs, cached: step.cached });
      deps.logger.debug(
        { fileId: file.id, name: step.name, durationMs: step.durationMs },
        "consolidated loop tool step",
      );
    },
  });
  const validated = validateDocument(outcome.value);
  if (
    validated.validation.droppedMentions > 0 ||
    validated.validation.droppedRelations > 0 ||
    validated.validation.droppedEntityFacts > 0
  ) {
    deps.logger.warn({ fileId: file.id, ...validated.validation }, "consolidated loop dropped malformed rows");
  }
  const guard = applyLinkAuthorityGuard(validated, offeredIds);
  const stagedDocument: ConsolidatedStagedDocument = {
    mentions: validated.mentions,
    relations: validated.relations,
    entityFacts: validated.entityFacts,
    summary: validated.summary,
    meta: {
      toolSteps,
      guard,
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
    guard,
    meta: outcome.meta,
  };
}
