/**
 * Path validation utilities for workspace file operations
 * Prevents directory traversal attacks and validates file paths.
 * validateFileName delegates to the shared fileNameSchema from @sketch/shared so
 * the same rules apply on both client and server without duplication.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { fileNameSchema } from "@sketch/shared";

interface ValidationResult {
  valid: boolean;
  error?: string;
  resolvedPath?: string;
}

/**
 * Normalizes a path for comparison by resolving it and removing trailing separator
 */
function normalizeForComparison(path: string): string {
  // Resolve to absolute path if not already
  const resolved = isAbsolute(path) ? path : resolve(path);
  // Remove trailing separator for consistent comparison
  return resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/**
 * Validates that a resolved path stays within the workspace root.
 * Prevents directory traversal attacks like ../../../etc/passwd.
 *
 * The workspace root is resolved via realpath before comparison so that symlinks in DATA_DIR
 * (or any parent directory) cannot be used to bypass the containment check.
 */
export async function validatePath(workspaceRoot: string, relativePath: string): Promise<ValidationResult> {
  // Check for empty path - but allow "." to represent root directory
  if (!relativePath || relativePath.trim() === "") {
    return { valid: false, error: "Path cannot be empty" };
  }

  // Resolve symlinks in the workspace root so the comparison uses canonical paths
  const realWorkspaceRoot = await realpath(workspaceRoot);

  // Handle root directory reference
  if (relativePath === "." || relativePath === "./") {
    return { valid: true, resolvedPath: normalizeForComparison(realWorkspaceRoot) };
  }

  // Reject absolute paths
  if (isAbsolute(relativePath)) {
    return { valid: false, error: "Absolute paths are not allowed" };
  }

  // Normalize the relative path and resolve against workspace root
  const normalizedRelative = normalize(relativePath);

  // Check for path traversal attempts - specifically looking for ".." as a path component
  // This handles cases like "../file", "../../etc/passwd", "dir/../file", etc.
  const pathParts = normalizedRelative.split(sep).filter((part) => part.length > 0);
  for (const part of pathParts) {
    if (part === "..") {
      return { valid: false, error: "Path traversal detected" };
    }
  }

  // Resolve the full path against the real (symlink-resolved) workspace root
  const resolvedPath = resolve(realWorkspaceRoot, normalizedRelative);

  // Normalize both paths for comparison
  const normalizedWorkspaceRoot = normalizeForComparison(realWorkspaceRoot);
  const normalizedResolvedPath = normalizeForComparison(resolvedPath);

  // Ensure resolved path starts with workspace root (it should be inside or equal to the root)
  if (
    normalizedResolvedPath !== normalizedWorkspaceRoot &&
    !normalizedResolvedPath.startsWith(normalizedWorkspaceRoot + sep)
  ) {
    return { valid: false, error: "Path is outside workspace" };
  }

  return { valid: true, resolvedPath };
}

interface FileNameValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a filename/folder name using the shared fileNameSchema from @sketch/shared.
 * Maps zod parse errors to the FileNameValidationResult shape used by callers.
 */
export function validateFileName(name: string): FileNameValidationResult {
  const result = fileNameSchema.safeParse(name);
  if (!result.success) {
    return { valid: false, error: result.error.issues[0]?.message ?? "Invalid name" };
  }
  return { valid: true };
}

/**
 * Resolves a path and validates it stays within workspace.
 * Also handles symlinks by checking the real path.
 */
export async function resolveAndValidatePath(workspaceRoot: string, relativePath: string): Promise<ValidationResult> {
  const validation = await validatePath(workspaceRoot, relativePath);
  if (!validation.valid) {
    return validation;
  }

  const resolvedFromValidation = validation.resolvedPath;
  if (!resolvedFromValidation) {
    return { valid: false, error: "Could not resolve path" };
  }

  try {
    // Check if path exists and resolve any symlinks
    const realPath = await realpath(resolvedFromValidation);

    // Re-validate after resolving symlinks — use realpath'd workspace root for consistent comparison
    const realRoot = await realpath(workspaceRoot);
    const normalizedWorkspaceRoot = normalizeForComparison(realRoot);
    const normalizedRealPath = normalizeForComparison(realPath);

    if (
      normalizedRealPath !== normalizedWorkspaceRoot &&
      !normalizedRealPath.startsWith(normalizedWorkspaceRoot + sep)
    ) {
      return { valid: false, error: "Symlink points outside workspace" };
    }

    return { valid: true, resolvedPath: realPath };
  } catch {
    // Path doesn't exist yet, which is fine for creation operations
    // Just use the resolved path from the first validation
    return { valid: true, resolvedPath: resolvedFromValidation };
  }
}

/**
 * Checks if a path is the workspace root or would delete the workspace root
 */
export function isWorkspaceRoot(workspaceRoot: string, relativePath: string): boolean {
  if (!relativePath || relativePath.trim() === "" || relativePath === "." || relativePath === "./") {
    return true;
  }
  const normalized = normalize(relativePath);
  return normalized === "." || normalized === "" || normalized === "/";
}
