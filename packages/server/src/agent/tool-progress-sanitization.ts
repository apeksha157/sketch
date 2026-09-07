const MAX_TECHNICAL_DETAIL_LENGTH = 16 * 1024;

const SAFE_DETAIL_KEYS = new Set([
  "action",
  "argv",
  "command",
  "file_path",
  "folder",
  "name",
  "pattern",
  "path",
  "query",
  "queries",
  "skill",
  "url",
]);

const SECRET_KEY =
  /(?:^|[_-])(api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|credential|password|private[_-]?key|secret|token)(?:$|[_-])/i;
const SENSITIVE_QUERY_KEY =
  /^(?:access[_-]?token|api[_-]?key|auth|auth(?:orization)?|client[_-]?secret|key|password|secret|sig(?:nature)?|token)$/i;
const SECRET_FLAG_WITH_VALUE =
  /^(?:--?(?:token|password|secret|api[-_]key|access[-_]token|client[-_]secret|private[-_]key|authorization|auth))=/i;

export interface SanitizedProgressDetail {
  detail?: string;
  detailFormat: "text" | "command" | "json";
  detailRedacted?: boolean;
  detailTruncated?: boolean;
  detailUnavailable?: boolean;
}

export const technicalDetailLimit = MAX_TECHNICAL_DETAIL_LENGTH;

function redactUrl(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  let result = value.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator: string, key: string) => {
    if (!SENSITIVE_QUERY_KEY.test(key)) return match;
    redacted = true;
    return `${separator}${key}=<redacted>`;
  });
  result = result.replace(/(https?:\/\/)([^\s/@:]+):[^\s/@]+@/gi, (_match, prefix: string, user: string) => {
    redacted = true;
    return `${prefix}${user}:<redacted>@`;
  });
  result = result.replace(
    /(["']?)([A-Za-z][A-Za-z0-9_-]{1,40})(["']?\s*:\s*["'])([^"']*)(["'])/g,
    (match, opening: string, key: string, separator: string, _secret: string, closing: string) => {
      if (!SECRET_KEY.test(key)) return match;
      redacted = true;
      return `${opening}${key}${separator}<redacted>${closing}`;
    },
  );
  return { value: result, redacted };
}

function redactHeaders(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  let result = value.replace(
    /((?:authorization|proxy-authorization|x-api-key|x-auth-token)\s*[:=]\s*)(?:(?:Bearer|Basic|Token)\s+)?[^\s'"\\]+/gi,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}<redacted>`;
    },
  );
  result = result.replace(
    /((?:--?(?:header|H)|--(?:api-key|token|secret|password))(?:=|\s+)(?:['"])?(?:authorization|proxy-authorization|x-api-key|x-auth-token)(?:\s*:\s*|=)(?:Bearer\s+)?)[^'"\s]+/gi,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}<redacted>`;
    },
  );
  result = result.replace(
    /((?:--?(?:token|password|secret|api-key|api_key|access-token|access_token|client-secret|client_secret|private-key|private_key|authorization|auth))(?:=|\s+))(?:(?:"[^"]*"|'[^']*'|[^\s;&|]+))/gi,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}<redacted>`;
    },
  );
  return { value: result, redacted };
}

function redactAssignments(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  const result = value.replace(
    /(^|[\s;&|])([A-Za-z_][A-Za-z0-9_-]*)=("[^"]*"|'[^']*'|[^\s;&|]*)/g,
    (match, prefix: string, key: string) => {
      if (!SECRET_KEY.test(key)) return match;
      redacted = true;
      return `${prefix}${key}=<redacted>`;
    },
  );
  return { value: result, redacted };
}

function sanitizeCommand(command: string): { value: string; redacted: boolean } | null {
  const credentials = command.replace(
    /(^|[\s;&|])(-u|--user|--proxy-user)(?:=|\s+)("(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)/g,
    "$1$2 <redacted>",
  );
  const embedded = redactEscapedJson(credentials);
  const uncertainJson = [
    ...embedded.value.matchAll(/\\?["']([A-Za-z][A-Za-z0-9_-]{1,40})\\?["']\s*:\s*\\?["']([^"']*)/g),
  ].some((match) => SECRET_KEY.test(match[1]) && !/^<redacted>\\?$/.test(match[2]));
  if (uncertainJson) return null;
  const assignment = redactAssignments(embedded.value);
  const header = redactHeaders(assignment.value);
  const steps = [embedded, assignment, header, { redacted: credentials !== command }];
  const redactedValue = header.value;
  const url = redactUrl(redactedValue);
  return { value: url.value, redacted: steps.some((step) => step.redacted) || url.redacted };
}

function boundDetail(value: string): Pick<SanitizedProgressDetail, "detail" | "detailTruncated"> {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_TECHNICAL_DETAIL_LENGTH) return { detail: value };
  const detail = new TextDecoder().decode(bytes.slice(0, MAX_TECHNICAL_DETAIL_LENGTH), { stream: true });
  return {
    detail,
    detailTruncated: true,
  };
}

function stringifyApprovedValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" || typeof entry === "number")) {
    return value.map(String).join(", ");
  }
  return null;
}

function stringifyApprovedDetail(value: unknown, format: "text" | "command" | "json"): string | null {
  if (format === "json") {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
    return JSON.stringify(value);
  }
  return stringifyApprovedValue(value);
}

function redactEscapedJson(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  const result = value.replace(
    /(\\?["'])([A-Za-z][A-Za-z0-9_-]{1,40})(\\?["']\s*:\s*\\?["'])([^"'\\]*)(\\?["'])/g,
    (match, opening: string, key: string, separator: string, _secret: string, closing: string) => {
      if (!SECRET_KEY.test(key)) return match;
      redacted = true;
      return `${opening}${key}${separator}<redacted>${closing}`;
    },
  );
  return { value: result, redacted };
}

function sanitizeArgv(value: unknown): { value: string; redacted: boolean } | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  const args = [...value] as string[];
  let redacted = false;
  const sensitiveFlag =
    /^(?:--?(?:token|password|secret|api[-_]key|access[-_]token|client[-_]secret|private[-_]key|authorization|auth)|--header|-H)$/i;
  for (let index = 0; index < args.length; index += 1) {
    const embedded = redactEscapedJson(args[index]);
    args[index] = embedded.value;
    redacted ||= embedded.redacted;
    const arg = args[index];
    if (sensitiveFlag.test(arg)) {
      if (args[index + 1] !== undefined) {
        args[index + 1] = "<redacted>";
        redacted = true;
      }
      continue;
    }
    if (SECRET_FLAG_WITH_VALUE.test(arg)) {
      args[index] = `${arg.slice(0, arg.indexOf("=") + 1)}<redacted>`;
      redacted = true;
    }
  }
  const url = redactUrl(JSON.stringify(args));
  const sanitized = redactHeaders(url.value);
  return { value: sanitized.value, redacted: redacted || url.redacted || sanitized.redacted };
}

/**
 * Produces the only argument representation that may enter Technical web progress.
 * Unknown objects are intentionally unavailable instead of being serialized wholesale.
 */
export function sanitizeProgressDetail(toolName: string, input: Record<string, unknown>): SanitizedProgressDetail {
  const displayName = toolName.match(/^mcp__.+?__(.+)$/)?.[1] ?? toolName;
  const detailKey =
    displayName === "Bash"
      ? "command"
      : ["Read", "Write", "Edit", "SendFileToChat", "TranscribeAudio", "VisualAnalysis"].includes(displayName)
        ? "file_path"
        : displayName === "Skill"
          ? "skill"
          : displayName === "ManageScheduledTasks"
            ? "action"
            : displayName === "github_cli"
              ? "argv"
              : displayName === "WebFetch"
                ? "url"
                : displayName === "WebSearch" ||
                    displayName === "Grep" ||
                    displayName === "Glob" ||
                    displayName === "SearchDeliveryTargets"
                  ? displayName === "Glob" || displayName === "Grep"
                    ? "pattern"
                    : "query"
                  : null;

  if (detailKey) {
    const raw = input[detailKey];
    const detailFormat = detailKey === "command" ? "command" : detailKey === "argv" ? "json" : "text";
    const value = stringifyApprovedDetail(raw, detailFormat);
    if (value === null) {
      return { detailFormat, detailUnavailable: raw !== undefined };
    }
    const sanitized =
      detailKey === "argv"
        ? (sanitizeArgv(raw) ?? { value, redacted: false })
        : detailKey === "command"
          ? sanitizeCommand(value)
          : redactUrl(value);
    if (!sanitized) return { detailFormat, detailUnavailable: true };
    return {
      detailFormat,
      ...boundDetail(sanitized.value),
      ...(sanitized.redacted ? { detailRedacted: true } : {}),
    };
  }

  for (const key of SAFE_DETAIL_KEYS) {
    if (!(key in input)) continue;
    const value = stringifyApprovedValue(input[key]);
    if (value === null) return { detailFormat: "json", detailUnavailable: true };
    const sanitized = key === "command" ? sanitizeCommand(value) : redactUrl(value);
    if (!sanitized) return { detailFormat: "command", detailUnavailable: true };
    return {
      detailFormat: key === "command" ? "command" : "text",
      ...boundDetail(sanitized.value),
      ...(sanitized.redacted ? { detailRedacted: true } : {}),
    };
  }

  return { detailFormat: "json", detailUnavailable: Object.keys(input).length > 0 };
}
