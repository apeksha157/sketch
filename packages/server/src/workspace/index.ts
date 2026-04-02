/**
 * Workspace module exports
 * Re-exports all workspace types and functions for use by API routes
 */
export { createWorkspaceService } from "./service";
export { workspaceRoutes } from "./routes";
export { validatePath, validateFileName, resolveAndValidatePath, isWorkspaceRoot } from "./validation";
export { WorkspaceError, type FileMetadata, type WorkspaceService } from "./types";
