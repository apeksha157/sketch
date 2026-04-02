/**
 * Workspace file types shared between server and web
 */

export interface FileMetadata {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
  isEditable: boolean;
  mimeType: string | null;
}
