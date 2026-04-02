/**
 * Context for file tree actions and state, eliminating prop drilling
 * through FileTreeNode → FolderContents → FileTreeNode recursion.
 */
import type { WorkspaceScope } from "@/api/workspace";
import type { FileMetadata } from "@sketch/shared";
import { createContext, useContext } from "react";

export interface FileTreeContextValue {
  scope: WorkspaceScope;
  selectedFile: string | null;
  expandedFolders: Set<string>;
  renamingPath: string | null;
  renameValue: string;
  creatingInFolder: { path: string; type: "file" | "folder" } | null;
  onToggleFolder: (path: string) => void;
  onFocusFolder: (path: string) => void;
  onFileClick: (path: string, isDirectory: boolean) => void;
  onStartRename: (path: string, name: string) => void;
  onRenameChange: (value: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
  onDeleteTarget: (path: string, isDirectory: boolean) => void;
  onDownload: (path: string) => void;
  onRegisterMetadata: (files: FileMetadata[]) => void;
  onCreateInFolder: (folderPath: string, type: "file" | "folder") => void;
  onCreateInFolderConfirm: (name: string) => void;
  onCreateInFolderCancel: () => void;
}

export const FileTreeContext = createContext<FileTreeContextValue | null>(null);

export function useFileTreeContext(): FileTreeContextValue {
  const ctx = useContext(FileTreeContext);
  if (!ctx) throw new Error("useFileTreeContext must be used within FileTreeContext.Provider");
  return ctx;
}
