/**
 * Workspace file operations service
 * Handles all business logic for file browsing, reading, writing, and management.
 *
 * Editability is determined purely from the file extension via getMimeType() — no file content is
 * read for this purpose. A file is considered editable if its MIME type starts with "text/" or is
 * one of the well-known non-text-prefixed editable application/* types below. This avoids reading
 * entire file contents just to determine editability (previously done via istextorbinary).
 */
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { ensureWorkspace } from "../agent/workspace";
import type { Config } from "../config";
import {
  type FileMetadata,
  type WorkspaceService as IWorkspaceService,
  WorkspaceError,
  type WorkspaceScope,
} from "./types";
import { isWorkspaceRoot, resolveAndValidatePath, validateFileName, validatePath } from "./validation";

const ONE_MB = 1024 * 1024;
const MAX_EDITABLE_SIZE = ONE_MB; // 1MB limit for editable files

const EDITABLE_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/sql",
  "application/x-sh",
  "application/powershell",
]);

/**
 * Determines whether a file is editable (i.e. human-readable text) based on its MIME type.
 * MIME types starting with "text/" are always editable; additionally we allow certain
 * "application/" subtypes that are plaintext in practice (JSON, JS, TS, XML, YAML, SQL, shell).
 */
function isEditableMimeType(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return mimeType.startsWith("text/") || EDITABLE_APPLICATION_MIME_TYPES.has(mimeType);
}

export async function resolveWorkspaceRoot(config: Config, userId: string, scope: WorkspaceScope): Promise<string> {
  if (scope === "org") {
    const orgDir = join(homedir(), ".claude");
    await mkdir(orgDir, { recursive: true });
    return orgDir;
  }
  return ensureWorkspace(config, userId);
}

export function createWorkspaceService(config: Config): IWorkspaceService {
  return {
    getWorkspacePath(userId: string, scope: WorkspaceScope): string {
      if (scope === "org") {
        return join(homedir(), ".claude");
      }
      return join(config.DATA_DIR, "workspaces", userId);
    },

    async listDirectory(userId: string, scope: WorkspaceScope, relativePath: string): Promise<FileMetadata[]> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);

      // Validate path
      const validation = await validatePath(workspaceRoot, relativePath);
      if (!validation.valid) {
        throw new WorkspaceError("INVALID_PATH", validation.error ?? "Invalid path", 400);
      }

      const targetPath = validation.resolvedPath;
      if (!targetPath) {
        throw new WorkspaceError("INVALID_PATH", "Could not resolve path", 400);
      }

      // Check if target exists and is a directory
      let stats: ReturnType<typeof stat> extends Promise<infer T> ? T : never;
      try {
        stats = await stat(targetPath);
      } catch {
        throw new WorkspaceError("NOT_FOUND", "Directory not found", 404);
      }

      if (!stats.isDirectory()) {
        throw new WorkspaceError("NOT_DIRECTORY", "Path is not a directory", 400);
      }

      // Read directory contents
      const entries = await readdir(targetPath, { withFileTypes: true });

      const files: FileMetadata[] = [];

      for (const entry of entries) {
        const entryPath = join(relativePath, entry.name);
        const fullPath = join(targetPath, entry.name);

        let entryStats: ReturnType<typeof stat> extends Promise<infer T> ? T : never;
        try {
          entryStats = await stat(fullPath);
        } catch {
          // Skip entries we can't stat (permissions, broken symlinks, etc.)
          continue;
        }

        const isDirectory = entryStats.isDirectory();
        let isEditable = false;
        let mimeType: string | null = null;

        if (!isDirectory) {
          mimeType = getMimeType(entry.name);
          isEditable = entryStats.size <= MAX_EDITABLE_SIZE && isEditableMimeType(mimeType);
        }

        files.push({
          name: entry.name,
          path: entryPath,
          size: entryStats.size,
          modifiedAt: entryStats.mtime.toISOString(),
          isDirectory,
          isEditable,
          mimeType,
        });
      }

      // Sort: directories first, then files, both alphabetically
      files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return files;
    },

    async readFile(
      userId: string,
      scope: WorkspaceScope,
      relativePath: string,
    ): Promise<{ content: Buffer; isText: boolean; size: number; mimeType: string | null }> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);

      // Validate and resolve path
      const validation = await resolveAndValidatePath(workspaceRoot, relativePath);
      if (!validation.valid) {
        throw new WorkspaceError("INVALID_PATH", validation.error ?? "Invalid path", 400);
      }

      const targetPath = validation.resolvedPath;
      if (!targetPath) {
        throw new WorkspaceError("INVALID_PATH", "Could not resolve path", 400);
      }

      // Check if file exists
      let stats: ReturnType<typeof stat> extends Promise<infer T> ? T : never;
      try {
        stats = await stat(targetPath);
      } catch {
        throw new WorkspaceError("NOT_FOUND", "File not found", 404);
      }

      if (stats.isDirectory()) {
        throw new WorkspaceError("IS_DIRECTORY", "Cannot read directory as file", 400);
      }

      // Read file content
      const content = await readFile(targetPath);
      const mimeType = getMimeType(relativePath);
      const isText = isEditableMimeType(mimeType);

      return { content, isText, size: stats.size, mimeType };
    },

    async writeFile(userId: string, scope: WorkspaceScope, relativePath: string, content: string): Promise<void> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);

      // Validate and resolve path
      const validation = await resolveAndValidatePath(workspaceRoot, relativePath);
      if (!validation.valid) {
        throw new WorkspaceError("INVALID_PATH", validation.error ?? "Invalid path", 400);
      }

      const targetPath = validation.resolvedPath;
      if (!targetPath) {
        throw new WorkspaceError("INVALID_PATH", "Could not resolve path", 400);
      }

      // Check if file exists and is not a directory
      try {
        const stats = await stat(targetPath);
        if (stats.isDirectory()) {
          throw new WorkspaceError("IS_DIRECTORY", "Cannot write to a directory", 400);
        }

        // Reject writing to binary files based on extension
        const mimeType = getMimeType(relativePath);
        if (!isEditableMimeType(mimeType)) {
          throw new WorkspaceError("NOT_TEXT_FILE", "Cannot edit binary files", 415);
        }

        // Check size limit for editing
        if (stats.size > MAX_EDITABLE_SIZE) {
          throw new WorkspaceError("FILE_TOO_LARGE", "File too large to edit (max 1MB)", 413);
        }
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        // File doesn't exist - will create new file
      }

      // Validate filename
      const pathParts = relativePath.split(sep);
      const fileName = pathParts[pathParts.length - 1] ?? "";
      const nameValidation = validateFileName(fileName);
      if (!nameValidation.valid) {
        throw new WorkspaceError("INVALID_NAME", nameValidation.error ?? "Invalid filename", 400);
      }

      // Ensure parent directory exists
      const parentDir = dirname(targetPath);
      await mkdir(parentDir, { recursive: true });

      // Write file
      await writeFile(targetPath, content, "utf-8");
    },

    async uploadFile(userId: string, scope: WorkspaceScope, relativePath: string, content: Buffer): Promise<void> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);

      // Check upload size limit
      const maxUploadSize = (config as Config & { MAX_UPLOAD_SIZE_MB?: number }).MAX_UPLOAD_SIZE_MB ?? 50;
      const maxSize = maxUploadSize * 1024 * 1024;
      if (content.length > maxSize) {
        throw new WorkspaceError("FILE_TOO_LARGE", `File exceeds maximum size of ${maxUploadSize}MB`, 413);
      }

      // Validate and resolve path
      const validation = await validatePath(workspaceRoot, relativePath);
      if (!validation.valid) {
        throw new WorkspaceError("INVALID_PATH", validation.error ?? "Invalid path", 400);
      }

      const targetPath = validation.resolvedPath;
      if (!targetPath) {
        throw new WorkspaceError("INVALID_PATH", "Could not resolve path", 400);
      }

      // Validate filename
      const pathParts = relativePath.split(sep);
      const fileName = pathParts[pathParts.length - 1] ?? "";
      const nameValidation = validateFileName(fileName);
      if (!nameValidation.valid) {
        throw new WorkspaceError("INVALID_NAME", nameValidation.error ?? "Invalid filename", 400);
      }

      // Ensure parent directory exists
      const parentDir = dirname(targetPath);
      await mkdir(parentDir, { recursive: true });

      // Write file
      await writeFile(targetPath, content);
    },

    async createFolder(userId: string, scope: WorkspaceScope, relativePath: string): Promise<void> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);

      // Validate and resolve path
      const validation = await validatePath(workspaceRoot, relativePath);
      if (!validation.valid) {
        throw new WorkspaceError("INVALID_PATH", validation.error ?? "Invalid path", 400);
      }

      const targetPath = validation.resolvedPath;
      if (!targetPath) {
        throw new WorkspaceError("INVALID_PATH", "Could not resolve path", 400);
      }

      // Validate folder name(s)
      const parts = relativePath.split(sep).filter((p) => p && p !== ".");
      for (const part of parts) {
        const nameValidation = validateFileName(part);
        if (!nameValidation.valid) {
          throw new WorkspaceError("INVALID_NAME", nameValidation.error ?? "Invalid folder name", 400);
        }
      }

      // Check if already exists
      try {
        const stats = await stat(targetPath);
        if (stats.isDirectory()) {
          throw new WorkspaceError("ALREADY_EXISTS", "Folder already exists", 409);
        }
        throw new WorkspaceError("FILE_EXISTS", "A file with that name already exists", 409);
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        // Doesn't exist - proceed to create
      }

      // Create folder (and parent folders if needed)
      await mkdir(targetPath, { recursive: true });
    },

    async renameFile(userId: string, scope: WorkspaceScope, oldPath: string, newPath: string): Promise<void> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);

      // Validate both paths
      const oldValidation = await resolveAndValidatePath(workspaceRoot, oldPath);
      if (!oldValidation.valid) {
        throw new WorkspaceError("INVALID_PATH", `Old path: ${oldValidation.error ?? "Invalid"}`, 400);
      }

      const newValidation = await validatePath(workspaceRoot, newPath);
      if (!newValidation.valid) {
        throw new WorkspaceError("INVALID_PATH", `New path: ${newValidation.error ?? "Invalid"}`, 400);
      }

      const oldFullPath = oldValidation.resolvedPath;
      const newFullPath = newValidation.resolvedPath;
      if (!oldFullPath || !newFullPath) {
        throw new WorkspaceError("INVALID_PATH", "Could not resolve path", 400);
      }

      // Check if source exists
      try {
        await stat(oldFullPath);
      } catch {
        throw new WorkspaceError("NOT_FOUND", "Source file not found", 404);
      }

      // Validate new filename
      const newPathParts = newPath.split(sep);
      const newFileName = newPathParts[newPathParts.length - 1] ?? "";
      const nameValidation = validateFileName(newFileName);
      if (!nameValidation.valid) {
        throw new WorkspaceError("INVALID_NAME", nameValidation.error ?? "Invalid filename", 400);
      }

      // Check if destination already exists
      try {
        await stat(newFullPath);
        throw new WorkspaceError("ALREADY_EXISTS", "A file with that name already exists", 409);
      } catch (err) {
        if (err instanceof WorkspaceError) throw err;
        // Destination doesn't exist - good
      }

      // Ensure parent directory of destination exists
      const parentDir = dirname(newFullPath);
      await mkdir(parentDir, { recursive: true });

      // Perform rename
      await rename(oldFullPath, newFullPath);
    },

    async deleteFile(userId: string, scope: WorkspaceScope, relativePath: string): Promise<void> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);

      // Prevent workspace root deletion
      if (isWorkspaceRoot(workspaceRoot, relativePath)) {
        throw new WorkspaceError("CANNOT_DELETE_ROOT", "Cannot delete root workspace", 403);
      }

      // Validate and resolve path
      const validation = await resolveAndValidatePath(workspaceRoot, relativePath);
      if (!validation.valid) {
        throw new WorkspaceError("INVALID_PATH", validation.error ?? "Invalid path", 400);
      }

      const targetPath = validation.resolvedPath;
      if (!targetPath) {
        throw new WorkspaceError("INVALID_PATH", "Could not resolve path", 400);
      }

      // Check if exists
      try {
        await stat(targetPath);
      } catch {
        throw new WorkspaceError("NOT_FOUND", "File or folder not found", 404);
      }

      // Delete (recursive for directories)
      await rm(targetPath, { recursive: true, force: true });
    },

    async searchFiles(userId: string, scope: WorkspaceScope, query: string): Promise<FileMetadata[]> {
      const workspaceRoot = await resolveWorkspaceRoot(config, userId, scope);
      const results: FileMetadata[] = [];
      const searchLower = query.toLowerCase();

      async function searchRecursive(currentPath: string, relativePath: string, depth: number) {
        if (depth > 10 || results.length >= 100) return;

        const entries = await readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          if (results.length >= 100) break;

          const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
          const fullPath = join(currentPath, entry.name);

          let entryStats: Awaited<ReturnType<typeof stat>>;
          try {
            entryStats = await stat(fullPath);
          } catch {
            continue;
          }

          const isDirectory = entryStats.isDirectory();
          const matchesSearch = entry.name.toLowerCase().includes(searchLower);

          if (matchesSearch) {
            let isEditable = false;
            let mimeType: string | null = null;

            if (!isDirectory) {
              mimeType = getMimeType(entry.name);
              isEditable = entryStats.size <= MAX_EDITABLE_SIZE && isEditableMimeType(mimeType);
            }

            results.push({
              name: entry.name,
              path: entryRelativePath,
              size: entryStats.size,
              modifiedAt: entryStats.mtime.toISOString(),
              isDirectory,
              isEditable,
              mimeType,
            });
          }

          // Recursively search subdirectories
          if (isDirectory) {
            await searchRecursive(fullPath, entryRelativePath, depth + 1);
          }
        }
      }

      await searchRecursive(workspaceRoot, "", 0);
      return results;
    },
  };
}

/**
 * Simple MIME type detection based on file extension
 */
function getMimeType(fileName: string): string | null {
  const ext = extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".js": "application/javascript",
    ".ts": "application/typescript",
    ".jsx": "application/javascript",
    ".tsx": "application/typescript",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".scss": "text/scss",
    ".sass": "text/sass",
    ".less": "text/less",
    ".xml": "application/xml",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".csv": "text/csv",
    ".py": "text/x-python",
    ".rb": "text/x-ruby",
    ".php": "text/x-php",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".go": "text/x-go",
    ".rs": "text/x-rust",
    ".swift": "text/x-swift",
    ".kt": "text/x-kotlin",
    ".sql": "application/sql",
    ".sh": "application/x-sh",
    ".bash": "application/x-sh",
    ".zsh": "application/x-sh",
    ".fish": "application/x-sh",
    ".ps1": "application/powershell",
    ".dockerfile": "text/x-dockerfile",
    ".env": "text/plain",
    ".gitignore": "text/plain",
    ".gitattributes": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".bz2": "application/x-bzip2",
    ".xz": "application/x-xz",
    ".7z": "application/x-7z-compressed",
    ".rar": "application/x-rar-compressed",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };

  return mimeTypes[ext] || null;
}
