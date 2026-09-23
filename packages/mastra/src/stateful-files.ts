import type { MastraRecordedFile } from "./memory-snapshot.js";

export interface ResolvedMemoryFile {
  bytes: Uint8Array;
  mediaType: string;
}

export type MemoryFileResolver = (url: string) => Promise<ResolvedMemoryFile>;

/** Bind processors to the invocation's declared content, with no live fallback. */
export function restoreCapturedFiles(recorded: readonly MastraRecordedFile[]) {
  const files = recorded.map((file) => ({
    ...file,
    bytes: new Uint8Array(file.bytes),
  }));
  const lookup = new Map(files.map((file) => [file.url, file]));
  if (lookup.size !== files.length)
    throw new Error("Duplicate recorded file URL");
  return {
    files,
    resolveFile: async (url: string): Promise<ResolvedMemoryFile> => {
      const file = lookup.get(url);
      if (!file)
        throw new Error(
          "Unsupported Mastra memory replay: file URL was not recorded.",
        );
      return { bytes: new Uint8Array(file.bytes), mediaType: file.mediaType };
    },
  };
}

/** Fetch each declared file before recording the immutable session input. */
export async function createCapturedFiles(
  urls: readonly string[],
  resolveFile: MemoryFileResolver,
) {
  const files: MastraRecordedFile[] = [];
  for (const url of new Set(urls)) {
    const resolved = await resolveFile(url);
    if (
      !(resolved.bytes instanceof Uint8Array) ||
      typeof resolved.mediaType !== "string" ||
      !resolved.mediaType
    )
      throw new TypeError("File resolver must return bytes and mediaType");
    files.push({
      url,
      bytes: new Uint8Array(resolved.bytes),
      mediaType: resolved.mediaType,
    });
  }
  return restoreCapturedFiles(files);
}
