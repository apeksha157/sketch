/**
 * Workspace file types and interfaces
 * FileMetadata is defined in @sketch/shared and re-exported here for convenience.
 * WorkspaceService, WorkspaceError, and WorkspaceErrorInfo are server-only.
 */
import type { FileMetadata } from "@sketch/shared";

export type { FileMetadata };

export type WorkspaceScope = "personal" | "org";

export interface WorkspaceService {
  listDirectory(userId: string, scope: WorkspaceScope, relativePath: string): Promise<FileMetadata[]>;
  readFile(
    userId: string,
    scope: WorkspaceScope,
    relativePath: string,
  ): Promise<{
    content: Buffer;
    isText: boolean;
    size: number;
    mimeType: string | null;
  }>;
  writeFile(userId: string, scope: WorkspaceScope, relativePath: string, content: string): Promise<void>;
  uploadFile(userId: string, scope: WorkspaceScope, relativePath: string, content: Buffer): Promise<void>;
  createFolder(userId: string, scope: WorkspaceScope, relativePath: string): Promise<void>;
  renameFile(userId: string, scope: WorkspaceScope, oldPath: string, newPath: string): Promise<void>;
  deleteFile(userId: string, scope: WorkspaceScope, relativePath: string): Promise<void>;
  getWorkspacePath(userId: string, scope: WorkspaceScope): string;
  searchFiles(userId: string, scope: WorkspaceScope, query: string): Promise<FileMetadata[]>;
}

export interface WorkspaceErrorInfo {
  code: string;
  message: string;
}

export class WorkspaceError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "WorkspaceError";
  }
}
