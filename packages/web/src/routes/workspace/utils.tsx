/**
 * File browser utilities — icon mapping, extension detection, language resolution.
 */
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileCsvIcon,
  FileDocIcon,
  FileIcon,
  FilePdfIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FolderIcon,
  FolderOpenIcon,
  ImageIcon,
} from "@phosphor-icons/react";

export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? "" : filename.slice(lastDot + 1).toLowerCase();
}

const LANGUAGE_MAP: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  jsx: "javascript",
  tsx: "typescript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  sh: "shell",
  bash: "shell",
  sql: "sql",
  graphql: "graphql",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  dart: "dart",
  lua: "lua",
  r: "r",
  dockerfile: "dockerfile",
  tf: "terraform",
};

export function getLanguageFromExtension(ext: string): string {
  return LANGUAGE_MAP[ext] || "plaintext";
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);
const CODE_EXTS = new Set([
  "js",
  "ts",
  "jsx",
  "tsx",
  "py",
  "java",
  "go",
  "rs",
  "cpp",
  "c",
  "h",
  "php",
  "rb",
  "swift",
  "kt",
]);
const TEXT_EXTS = new Set(["md", "txt", "json", "yaml", "yml", "xml", "env", "gitignore"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "bz2", "xz", "7z", "rar"]);
const AUDIO_EXTS = new Set(["mp3", "ogg", "wav", "flac", "aac"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "avi", "mkv"]);

export function FileIconComponent({
  fileName,
  isDirectory,
  isExpanded,
}: {
  fileName: string;
  isDirectory: boolean;
  isExpanded?: boolean;
}) {
  if (isDirectory) {
    return isExpanded ? (
      <FolderOpenIcon size={18} className="text-warning" />
    ) : (
      <FolderIcon size={18} className="text-warning" />
    );
  }

  const ext = getFileExtension(fileName);

  if (IMAGE_EXTS.has(ext)) return <ImageIcon size={18} className="text-success" />;
  if (ext === "pdf") return <FilePdfIcon size={18} className="text-destructive" />;
  if (ext === "doc" || ext === "docx") return <FileDocIcon size={18} className="text-info" />;
  if (ext === "xls" || ext === "xlsx") return <FileXlsIcon size={18} className="text-success" />;
  if (ext === "csv") return <FileCsvIcon size={18} className="text-success" />;
  if (CODE_EXTS.has(ext)) return <FileCodeIcon size={18} className="text-primary" />;
  if (TEXT_EXTS.has(ext)) return <FileTextIcon size={18} className="text-info" />;
  if (ARCHIVE_EXTS.has(ext)) return <FileArchiveIcon size={18} className="text-muted-foreground" />;
  if (AUDIO_EXTS.has(ext)) return <FileAudioIcon size={18} className="text-warning" />;
  if (VIDEO_EXTS.has(ext)) return <FileVideoIcon size={18} className="text-warning" />;

  return <FileIcon size={18} className="text-muted-foreground" />;
}
