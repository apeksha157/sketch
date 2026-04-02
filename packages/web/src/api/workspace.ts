import { type WorkspaceScope, api } from "@/lib/api";
/**
 * TanStack Query hooks for workspace file operations
 * Provides queries and mutations for the file browser UI
 */
import type { FileMetadata } from "@sketch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type { WorkspaceScope };

const WORKSPACE_QUERY_KEY = "workspace";
const WORKSPACE_FILES_KEY = "workspace-files";

interface FileContent {
  content: string;
  isText: boolean;
  size: number;
  mimeType: string | null;
}

// Query: List files in directory
export function useFiles(scope: WorkspaceScope, path: string) {
  return useQuery({
    queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, path],
    queryFn: () => api.workspace.listFiles(scope, path),
    enabled: path !== undefined,
  });
}

// Query: Search files recursively
export function useSearchFiles(scope: WorkspaceScope, query: string) {
  return useQuery({
    queryKey: [WORKSPACE_QUERY_KEY, "search", scope, query],
    queryFn: () => api.workspace.searchFiles(scope, query),
    enabled: query !== undefined && query.trim().length > 0,
  });
}

// Query: Get file content
export function useFileContent(scope: WorkspaceScope, path: string | null) {
  return useQuery({
    queryKey: [WORKSPACE_QUERY_KEY, "content", scope, path],
    queryFn: async (): Promise<FileContent | null> => {
      if (!path) return null;
      return api.workspace.getFileContent(scope, path);
    },
    enabled: !!path,
  });
}

// Mutation: Save file edits
export function useSaveFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { scope: WorkspaceScope; path: string; content: string }) => {
      return api.workspace.saveFile(params.scope, params.path, params.content);
    },
    onSuccess: (_, { scope, path }) => {
      // Invalidate the file content query to refresh
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, "content", scope, path] });
      // Also invalidate the parent directory listing in case size/modified time changed
      const parentPath = path.split("/").slice(0, -1).join("/") || ".";
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, parentPath] });
    },
  });
}

// Mutation: Upload file
export function useUploadFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { scope: WorkspaceScope; path: string; file: File }) => {
      const formData = new FormData();
      formData.append("file", params.file);
      return api.workspace.uploadFile(params.scope, params.path, formData);
    },
    onSuccess: (_, { scope, path }) => {
      // Invalidate the parent directory listing
      const parentPath = path.split("/").slice(0, -1).join("/") || ".";
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, parentPath] });
    },
  });
}

// Mutation: Create folder
export function useCreateFolder() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { scope: WorkspaceScope; path: string }) => {
      return api.workspace.createFolder(params.scope, params.path);
    },
    onSuccess: (_, { scope, path }) => {
      // Invalidate the parent directory listing
      const parentPath = path.split("/").slice(0, -1).join("/") || ".";
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, parentPath] });
    },
  });
}

// Mutation: Create empty file
export function useCreateFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { scope: WorkspaceScope; path: string }) => {
      return api.workspace.createFile(params.scope, params.path);
    },
    onSuccess: (_, { scope, path }) => {
      // Invalidate the parent directory listing
      const parentPath = path.split("/").slice(0, -1).join("/") || ".";
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, parentPath] });
    },
  });
}

// Mutation: Delete file/folder
export function useDeleteFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { scope: WorkspaceScope; path: string }) => {
      return api.workspace.deleteFile(params.scope, params.path);
    },
    onSuccess: (_, { scope, path }) => {
      // Invalidate the parent directory listing
      const parentPath = path.split("/").slice(0, -1).join("/") || ".";
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, parentPath] });
      // Invalidate any content query for this path
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, "content", scope, path] });
    },
  });
}

// Mutation: Rename file/folder
export function useRenameFile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { scope: WorkspaceScope; oldPath: string; newPath: string }) => {
      return api.workspace.renameFile(params.scope, params.oldPath, params.newPath);
    },
    onSuccess: (_, { scope, oldPath, newPath }) => {
      // Invalidate both parent directories
      const oldParent = oldPath.split("/").slice(0, -1).join("/") || ".";
      const newParent = newPath.split("/").slice(0, -1).join("/") || ".";
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, oldParent] });
      if (oldParent !== newParent) {
        queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, WORKSPACE_FILES_KEY, scope, newParent] });
      }
      // Invalidate content queries
      queryClient.invalidateQueries({ queryKey: [WORKSPACE_QUERY_KEY, "content", scope, oldPath] });
    },
  });
}
