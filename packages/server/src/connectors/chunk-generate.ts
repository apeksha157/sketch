import type { GeminiGenerator, GenerateOptions } from "./gemini-generate";

export type ChunkGenerate = (prompt: string, opts: GenerateOptions) => Promise<string>;

export function createChunkGenerate(
  generator: Pick<GeminiGenerator, "generate"> | null | undefined,
): ChunkGenerate | undefined {
  return generator ? (prompt, opts) => generator.generate(prompt, opts) : undefined;
}
