import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod/v4";
import { handleSearchDeliveryTargets } from "../../agent/tools/delivery-targets";
import { handleSendMessageToTarget } from "../../agent/tools/messaging";
import {
  getEntityContextToolDescription,
  getEntityContextToolSchema,
  getFileContentToolDescription,
  getFileContentToolSchema,
  handleGetEntityContext,
  handleGetFileContent,
  handleSearch,
  handleSearchEntities,
  searchEntitiesToolDescription,
  searchEntitiesToolSchema,
  searchToolDescription,
  searchToolSchema,
} from "../../agent/tools/search";
import { type SendTargetMessage, type SketchMcpDeps, type ToolResult, UploadCollector } from "../../agent/tools/types";
import { toEmailPrincipals } from "../../connectors/types";
import { viewerPrincipals } from "../../db/repositories/connectors";
import type { createExternalMcpToolCallRepository } from "../../db/repositories/external-mcp-tool-calls";
import { getWhatsAppLidsForUser } from "../../db/repositories/user-whatsapp-lids";
import type { createUserRepository } from "../../db/repositories/users";
import type { DB } from "../../db/schema";
import type { SlackBot } from "../../slack/bot";
import type { WhatsAppRuntime } from "../../whatsapp/runtime";
import { Semaphore, createTokenBucketRateLimiter } from "./rate-limit";

type UserRepo = ReturnType<typeof createUserRepository>;
type AuditRepo = ReturnType<typeof createExternalMcpToolCallRepository>;

const MAX_FILE_CONTENT_CHARS = 50_000;
const toolSemaphore = new Semaphore(4);
const sendLimiter = createTokenBucketRateLimiter({ capacity: 5, refillPerMinute: 5 });

type PublicSearchDeliveryTargetsArgs = {
  query?: string;
  platform?: "slack" | "whatsapp";
  targetType: "channel" | "group";
  limit?: number;
  cursor?: string;
};

type PublicSendMessageArgs = {
  platform: "slack" | "whatsapp";
  targetId: string;
  message: string;
  threadTs?: string;
};

const publicSearchDeliveryTargetsSchema = {
  query: z
    .string()
    .optional()
    .describe("Optional target name to search, such as 'engineering', 'ops', or a WhatsApp group name."),
  platform: z.enum(["slack", "whatsapp"]).optional().describe("Optional platform filter."),
  targetType: z
    .enum(["channel", "group"])
    .describe("Required target type filter. Use 'channel' for Slack and 'group' for WhatsApp."),
  limit: z.number().int().min(1).max(100).optional().describe("Maximum number of results to return. Defaults to 10."),
  cursor: z.string().optional().describe("Cursor from a previous response to fetch the next page."),
};

const publicSendMessageSchema = {
  platform: z.enum(["slack", "whatsapp"]).describe("The platform the target belongs to."),
  targetId: z
    .string()
    .describe("The targetId returned by sketch_search_delivery_targets. Never guess a channel ID or group JID."),
  message: z.string().describe("The message to send. Must not be empty."),
  threadTs: z.string().optional().describe("Slack thread timestamp for a threaded reply. Slack only."),
};

const publicSearchDeliveryTargetsDescription =
  "Search/list deliverable Slack channels and WhatsApp groups. targetType is required and must be 'channel' for Slack or 'group' for WhatsApp. Use this before sketch_send_message.";

const publicSendMessageDescription =
  "Send a message to a Slack channel or WhatsApp group the authenticated user belongs to. Resolve the target with sketch_search_delivery_targets first and pass its targetId exactly.";

function filterPublicDeliveryTargets(result: ToolResult): ToolResult {
  const text = result.content[0]?.text;
  if (!text) return result;
  try {
    const body = JSON.parse(text) as { matches?: unknown; nextCursor?: unknown };
    if (!Array.isArray(body.matches)) return result;
    const matches = body.matches.filter((match) => {
      if (!match || typeof match !== "object") return false;
      const targetType = (match as { targetType?: unknown }).targetType;
      return targetType === "channel" || targetType === "group";
    });
    return {
      ...result,
      content: [
        { type: "text", text: JSON.stringify({ ...body, matches, nextCursor: body.nextCursor ?? null }, null, 2) },
      ],
    };
  } catch {
    return result;
  }
}

async function resolveFullMessagingPrincipals(params: {
  db: Kysely<DB>;
  userRepo: UserRepo;
  userId: string;
}) {
  const user = await params.userRepo.findById(params.userId);
  const emails = await params.userRepo.getVerifiedEmailsForUser(params.userId);
  if (!user) return toEmailPrincipals(emails);
  return viewerPrincipals({
    email: null,
    emails,
    phone: user.whatsapp_number,
    slackUserId: user.slack_user_id,
    whatsappLid: user.whatsapp_lid,
    whatsappLids: await getWhatsAppLidsForUser(params.db, user.id),
    isAdmin: false,
  });
}

export async function createPublicSketchMcpServer(params: {
  db: Kysely<DB>;
  userRepo: UserRepo;
  userId: string;
  tokenId: string;
  workspaceDir: string;
  auditRepo: AuditRepo;
  getSlack?: () => SlackBot | null;
  whatsappRuntime?: WhatsAppRuntime;
  sendTargetMessage?: SendTargetMessage;
  logger?: Logger;
}): Promise<McpServer> {
  const userPrincipals = toEmailPrincipals(await params.userRepo.getVerifiedEmailsForUser(params.userId));
  const messagingPrincipals = await resolveFullMessagingPrincipals(params);
  const deps: SketchMcpDeps = {
    uploadCollector: new UploadCollector(),
    workspaceDir: params.workspaceDir,
    db: params.db,
    userRepo: params.userRepo,
    currentUserId: params.userId,
    logger: params.logger,
    getSlack: params.getSlack,
    getWhatsApp: params.whatsappRuntime
      ? () => ({ isConnected: params.whatsappRuntime?.isConnected === true })
      : undefined,
    sendTargetMessage: params.sendTargetMessage,
    publicMcp: {
      userPrincipals,
      filterEntityMetadata: true,
      maxFileContentChars: MAX_FILE_CONTENT_CHARS,
    },
  };
  const messagingDeps: SketchMcpDeps = {
    ...deps,
    publicMcp: {
      ...deps.publicMcp,
      userPrincipals: messagingPrincipals,
    },
  };
  const server = new McpServer({ name: "sketch", version: "1.0.0" });

  function register<TArgs extends Record<string, unknown>>(
    name: string,
    description: string,
    inputSchema: ZodRawShapeCompat,
    handler: (args: TArgs, deps: SketchMcpDeps) => Promise<ToolResult>,
    options: { deps?: SketchMcpDeps } = {},
  ) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      const startedAt = Date.now();
      let success = false;
      try {
        const typedArgs = args as TArgs;
        const result = await toolSemaphore.run(() => handler(typedArgs, options.deps ?? deps));
        success = result.isError !== true;
        return result;
      } finally {
        const durationMs = Date.now() - startedAt;
        void params.auditRepo
          .create({
            tokenId: params.tokenId,
            userId: params.userId,
            toolName: name,
            success,
            durationMs,
          })
          .catch(() => undefined);
      }
    });
  }

  register("sketch_search", searchToolDescription, searchToolSchema, (args, deps) =>
    handleSearch(args, deps, "public_mcp"),
  );
  register("sketch_search_entities", searchEntitiesToolDescription, searchEntitiesToolSchema, handleSearchEntities);
  register(
    "sketch_get_entity_context",
    getEntityContextToolDescription,
    getEntityContextToolSchema,
    handleGetEntityContext,
  );
  register("sketch_get_file_content", getFileContentToolDescription, getFileContentToolSchema, handleGetFileContent);
  register<PublicSearchDeliveryTargetsArgs>(
    "sketch_search_delivery_targets",
    publicSearchDeliveryTargetsDescription,
    publicSearchDeliveryTargetsSchema,
    (args, deps) => handleSearchDeliveryTargets(args, deps).then(filterPublicDeliveryTargets),
    { deps: messagingDeps },
  );
  register<PublicSendMessageArgs>(
    "sketch_send_message",
    publicSendMessageDescription,
    publicSendMessageSchema,
    async (args, deps) => {
      if (!sendLimiter.consume(params.tokenId)) {
        params.logger?.warn(
          { platform: args.platform, targetId: args.targetId, outcome: "rate_limited" },
          "Public MCP send message attempt",
        );
        return { content: [{ type: "text", text: "Error: send message rate limit exceeded." }], isError: true };
      }
      const targetType = args.platform === "slack" ? "channel" : "group";
      const result = await handleSendMessageToTarget(
        {
          message: args.message,
          target: { platform: args.platform, targetType, targetId: args.targetId },
          ...(args.threadTs ? { threadTs: args.threadTs } : {}),
        },
        deps,
      );
      params.logger?.info(
        { platform: args.platform, targetId: args.targetId, outcome: result.isError === true ? "error" : "sent" },
        "Public MCP send message attempt",
      );
      return result;
    },
    { deps: messagingDeps },
  );

  return server;
}
