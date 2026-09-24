import { createHash } from "node:crypto";
import type { MastraRecordedFile } from "./memory-snapshot.js";

export interface ResolvedMemoryFile {
  bytes: Uint8Array;
  mediaType: string;
}

export type MemoryFileResolver = (url: string) => Promise<ResolvedMemoryFile>;

export interface RecordedEvidenceSanitizer {
  replace<T>(value: T): T;
}

export type UnsafeEvidenceReason = "credential_url" | "unsupported_value";

const FILE_REFERENCE = /^kitaru-file:\/\/sha256\/[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDED_FILES = 64;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const CREDENTIAL_QUERY_KEY =
  /^(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|signature|sig|secret|auth|authorization|credential|x-amz-[\w-]+|x-goog-[\w-]+)$/i;

function hasUrlCredential(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      Boolean(parsed.username || parsed.password) ||
      [...parsed.searchParams.keys()].some((key) =>
        CREDENTIAL_QUERY_KEY.test(key),
      )
    );
  } catch {
    return /[?&](?:token|signature|sig|secret|auth|credential)=/i.test(url);
  }
}

export function fileReference(file: ResolvedMemoryFile): string {
  const digest = createHash("sha256")
    .update(file.mediaType)
    .update("\0")
    .update(file.bytes)
    .digest("hex");
  return `kitaru-file://sha256/${digest}`;
}

function copiedFile(file: MastraRecordedFile): MastraRecordedFile {
  if (
    !FILE_REFERENCE.test(file.url) ||
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength > MAX_FILE_BYTES ||
    typeof file.mediaType !== "string" ||
    !file.mediaType ||
    fileReference(file) !== file.url
  )
    throw new Error("Unsupported Mastra memory replay: invalid recorded file.");
  return { ...file, bytes: new Uint8Array(file.bytes) };
}

/** Replay resolves only captured content references, never network URLs. */
export function restoreCapturedFiles(recorded: readonly MastraRecordedFile[]) {
  if (
    recorded.length > MAX_RECORDED_FILES ||
    recorded.reduce(
      (size, file) =>
        size + (file.bytes instanceof Uint8Array ? file.bytes.byteLength : 0),
      0,
    ) > MAX_TOTAL_FILE_BYTES
  )
    throw new Error(
      "Unsupported Mastra memory replay: file capture limit exceeded.",
    );
  const files = recorded.map(copiedFile);
  const lookup = new Map(files.map((file) => [file.url, file]));
  if (lookup.size !== files.length)
    throw new Error(
      "Unsupported Mastra memory replay: duplicate recorded file.",
    );
  return {
    files,
    resolveFile: async (reference: string): Promise<ResolvedMemoryFile> => {
      const file = lookup.get(reference);
      if (!file)
        throw new Error(
          "Unsupported Mastra memory replay: file reference was not recorded.",
        );
      return { bytes: new Uint8Array(file.bytes), mediaType: file.mediaType };
    },
  };
}

/** Sanitize every persisted evidence field, including URLs inside prompt text. */
export function createRecordedEvidenceSanitizer(
  references: ReadonlyMap<string, string>,
  onUnsafeEvidence: (reason: UnsafeEvidenceReason) => void,
): RecordedEvidenceSanitizer {
  const declared = [...references].sort(
    (left, right) => right[0].length - left[0].length,
  );
  function replaceString(value: string): string {
    let replaced = value;
    for (const [url, reference] of declared) {
      replaced = replaced.split(url).join(reference);
    }
    return replaced.replace(URL_IN_TEXT, (url) => {
      if (!hasUrlCredential(url)) return url;
      onUnsafeEvidence("credential_url");
      return "[redacted credential URL]";
    });
  }
  function replace<T>(value: T): T {
    const active = new Set<object>();
    function visit(current: unknown): unknown {
      if (typeof current === "string") return replaceString(current);
      if (current instanceof URL) return replaceString(current.href);
      if (current instanceof Date || current instanceof Uint8Array)
        return current;
      if (
        current instanceof ArrayBuffer ||
        typeof current === "function" ||
        typeof current === "symbol"
      ) {
        onUnsafeEvidence("unsupported_value");
        return "[unrecordable evidence value]";
      }
      if (current === null || typeof current !== "object") return current;
      if (active.has(current)) {
        onUnsafeEvidence("unsupported_value");
        return "[unrecordable circular evidence]";
      }
      active.add(current);
      try {
        if (Array.isArray(current)) {
          if (
            Object.values(Object.getOwnPropertyDescriptors(current)).some(
              (descriptor) => descriptor.enumerable && !("value" in descriptor),
            )
          ) {
            onUnsafeEvidence("unsupported_value");
            return "[unrecordable accessor evidence]";
          }
          return current.map(visit);
        }
        if (
          (Object.getPrototypeOf(current) !== Object.prototype &&
            Object.getPrototypeOf(current) !== null) ||
          Reflect.ownKeys(current).some((key) => typeof key !== "string")
        ) {
          onUnsafeEvidence("unsupported_value");
          return "[unrecordable evidence value]";
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        if (
          Object.values(descriptors).some(
            (descriptor) => descriptor.enumerable && !("value" in descriptor),
          )
        ) {
          onUnsafeEvidence("unsupported_value");
          return "[unrecordable accessor evidence]";
        }
        return Object.fromEntries(
          Object.entries(current).map(([key, item]) => [
            replaceString(key),
            visit(item),
          ]),
        );
      } finally {
        active.delete(current);
      }
    }
    return visit(value) as T;
  }
  return { replace };
}

/** Capture declared URLs once and convert persisted input to secret-free references. */
export async function createCapturedFiles(
  urls: readonly string[],
  resolveFile: MemoryFileResolver,
) {
  const originalToReference = new Map<string, string>();
  const filesByReference = new Map<string, MastraRecordedFile>();
  const uniqueUrls = new Set(urls);
  if (uniqueUrls.size > MAX_RECORDED_FILES)
    throw new Error(
      "Unsupported Mastra memory replay: file count limit exceeded.",
    );
  let totalBytes = 0;
  for (const url of uniqueUrls) {
    let resolved: ResolvedMemoryFile;
    try {
      resolved = await resolveFile(url);
    } catch {
      // Resolver errors can contain a signed URL. Keep them out of diagnostics.
      throw new Error("Controlled file capture failed.");
    }
    if (
      !(resolved.bytes instanceof Uint8Array) ||
      typeof resolved.mediaType !== "string" ||
      !resolved.mediaType
    )
      throw new TypeError("File resolver must return bytes and mediaType");
    if (resolved.bytes.byteLength > MAX_FILE_BYTES)
      throw new Error("Unsupported Mastra memory replay: file exceeds 8 MiB.");
    totalBytes += resolved.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_FILE_BYTES)
      throw new Error("Unsupported Mastra memory replay: files exceed 16 MiB.");
    const file = {
      url: fileReference(resolved),
      bytes: new Uint8Array(resolved.bytes),
      mediaType: resolved.mediaType,
    };
    originalToReference.set(url, file.url);
    filesByReference.set(file.url, file);
  }
  const captured = restoreCapturedFiles([...filesByReference.values()]);
  const declared = [...originalToReference].sort(
    (left, right) => right[0].length - left[0].length,
  );
  function referenceFor(url: string): string {
    const reference = originalToReference.get(url);
    if (!reference)
      throw new Error("Unsupported Mastra memory replay: undeclared file URL.");
    return reference;
  }
  function replaceDeclaredFileUrls<T>(value: T): T {
    const active = new Set<object>();
    function visit(current: unknown, filePart: boolean): unknown {
      if (typeof current === "string") {
        const reference = originalToReference.get(current);
        if (reference) return reference;
        if (filePart && /^https?:\/\//i.test(current))
          throw new Error(
            "Unsupported Mastra memory replay: undeclared file URL.",
          );
        let replaced = current;
        for (const [url, fileReference] of declared)
          replaced = replaced.split(url).join(fileReference);
        return replaced;
      }
      if (current instanceof URL) {
        const reference = originalToReference.get(current.href);
        if (reference) return new URL(reference);
        if (filePart && /^https?:$/i.test(current.protocol))
          throw new Error(
            "Unsupported Mastra memory replay: undeclared file URL.",
          );
        return current;
      }
      if (
        current === null ||
        typeof current !== "object" ||
        current instanceof Date ||
        current instanceof Uint8Array
      )
        return current;
      if (active.has(current))
        throw new Error(
          "Unsupported Mastra memory replay: circular file input.",
        );
      active.add(current);
      try {
        if (Array.isArray(current)) {
          if (
            Reflect.ownKeys(current).some((key) => {
              const descriptor = Object.getOwnPropertyDescriptor(current, key);
              return descriptor && !("value" in descriptor);
            })
          )
            throw new Error(
              "Unsupported Mastra memory replay: file input accessor.",
            );
          return current.map((item) => visit(item, filePart));
        }
        if (
          (Object.getPrototypeOf(current) !== Object.prototype &&
            Object.getPrototypeOf(current) !== null) ||
          Reflect.ownKeys(current).some((key) => typeof key !== "string")
        )
          throw new Error("Unsupported Mastra memory replay: file input type.");
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const part =
          filePart ||
          descriptors.type?.value === "file" ||
          descriptors.type?.value === "image";
        const entries = Object.entries(descriptors);
        return Object.fromEntries(
          entries.map(([key, descriptor]) => {
            if (!descriptor.enumerable || !("value" in descriptor))
              throw new Error(
                "Unsupported Mastra memory replay: file input accessor.",
              );
            return [key, visit(descriptor.value, part)];
          }),
        );
      } finally {
        active.delete(current);
      }
    }
    return visit(value, false) as T;
  }
  return {
    files: captured.files,
    referenceFor,
    evidenceSanitizer: (
      onUnsafeEvidence: (reason: UnsafeEvidenceReason) => void,
    ) => createRecordedEvidenceSanitizer(originalToReference, onUnsafeEvidence),
    replaceDeclaredFileUrls,
    resolveFile: async (url: string): Promise<ResolvedMemoryFile> =>
      captured.resolveFile(referenceFor(url)),
  };
}
