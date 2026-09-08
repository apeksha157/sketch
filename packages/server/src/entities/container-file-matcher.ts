import type { Selectable } from "kysely";
import type { ContainersTable, IndexedFilesTable } from "../db/schema";

export type ContainerFileMatcherContainer = Pick<Selectable<ContainersTable>, "external_id" | "path_names" | "name">;

export type ContainerFileMatcherFile = Pick<
  Selectable<IndexedFilesTable>,
  "provider_file_id" | "rollup_group_id" | "source_path" | "source_meta"
>;

export type FileWithContainerMeta<T extends ContainerFileMatcherFile> = {
  row: T;
  metaValues: Set<string>;
};

export function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function pathForContainer(container: ContainerFileMatcherContainer): string[] {
  return [...parseJsonArray(container.path_names), container.name];
}

/**
 * Meta values are collected once per file rather than re-parsed per container:
 * the judge and membership pass cross-check every container against every file,
 * and repeating the JSON deep-scan per pair blocks the event loop for minutes
 * on large tenants. Only string values are kept because external ids are always
 * strings.
 */
export function collectMetaStringValues(raw: string | null): Set<string> {
  const values = new Set<string>();
  if (!raw) return values;
  try {
    for (const value of sourceMetaContainerEvidence(JSON.parse(raw) as unknown)) values.add(value);
  } catch {
    return values;
  }
  return values;
}

export function sourceMetaContainerEvidence(sourceMeta: unknown): string[] {
  const values = new Set<string>();
  const root =
    sourceMeta && typeof sourceMeta === "object" && !Array.isArray(sourceMeta)
      ? { ...(sourceMeta as Record<string, unknown>), zohoCrm: undefined }
      : sourceMeta;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      values.add(item);
    } else if (Array.isArray(item)) {
      stack.push(...item);
    } else if (item && typeof item === "object") {
      stack.push(...Object.values(item as Record<string, unknown>));
    }
  }
  return [...values];
}

export function prepareFilesForContainerMatching<T extends ContainerFileMatcherFile>(
  files: T[],
): FileWithContainerMeta<T>[] {
  return files.map((row) => ({
    row,
    metaValues: collectMetaStringValues(row.source_meta),
  }));
}

function sourcePathMatches(sourcePath: string | null, path: string[]): boolean {
  if (!sourcePath || path.length === 0) return false;
  const joined = path.join(" / ");
  return sourcePath === joined || sourcePath.startsWith(`${joined} / `);
}

export function filesForContainer<T extends ContainerFileMatcherFile>(
  container: ContainerFileMatcherContainer,
  files: FileWithContainerMeta<T>[],
): T[] {
  const exact = files.filter(
    (file) =>
      file.row.provider_file_id === container.external_id ||
      file.row.rollup_group_id === container.external_id ||
      file.metaValues.has(container.external_id),
  );
  if (exact.length > 0) return exact.map((file) => file.row);
  const path = pathForContainer(container);
  return files.filter((file) => sourcePathMatches(file.row.source_path, path)).map((file) => file.row);
}
