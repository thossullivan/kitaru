import { expect, it, vi } from "vitest";
import {
  decodeMemoryValue,
  encodeMemoryValue,
} from "../src/memory-snapshot.js";
import {
  createCapturedFiles,
  fileReference,
  restoreCapturedFiles,
} from "../src/stateful-files.js";

it("captures signed URLs under secret-free references and replays immutable bytes", async () => {
  const resolver = vi.fn(async () => ({
    bytes: new Uint8Array([0, 255, 1]),
    mediaType: "application/pdf",
  }));
  const signedUrl = "https://files.invalid/a?token=PRIVATE_TOKEN";
  const captured = await createCapturedFiles([signedUrl, signedUrl], resolver);
  const reference = captured.referenceFor(signedUrl);
  expect(reference).toMatch(/^kitaru-file:\/\/sha256\/[a-f0-9]{64}$/);
  expect(JSON.stringify(captured.files)).not.toContain("PRIVATE_TOKEN");
  expect(JSON.stringify(captured.files)).not.toContain("files.invalid");
  const replay = restoreCapturedFiles(captured.files);
  (await captured.resolveFile(signedUrl)).bytes[0] = 9;
  expect((await replay.resolveFile(reference)).bytes).toEqual(
    new Uint8Array([0, 255, 1]),
  );
  await expect(replay.resolveFile(signedUrl)).rejects.toThrow(/not recorded/);
  expect(resolver).toHaveBeenCalledTimes(1);
});

it("rewrites declared file and image URLs without changing baseline input", async () => {
  const signedUrl = "https://files.invalid/a?X-Amz-Signature=SECRET";
  const captured = await createCapturedFiles([signedUrl], async () => ({
    bytes: new Uint8Array([1, 2]),
    mediaType: "image/png",
  }));
  const baseline = {
    messages: [
      { role: "user", content: [{ type: "image", image: new URL(signedUrl) }] },
    ],
    context: { attachment: signedUrl },
  };
  const historical = captured.replaceDeclaredFileUrls(baseline);
  expect(baseline.messages[0]?.content[0]?.image.href).toBe(signedUrl);
  expect(historical.messages[0]?.content[0]?.image.href).toBe(
    captured.referenceFor(signedUrl),
  );
  expect(historical.context.attachment).toBe(captured.referenceFor(signedUrl));
  expect(JSON.stringify(historical)).not.toContain("SECRET");
  await expect(
    Promise.resolve().then(() =>
      captured.replaceDeclaredFileUrls({
        type: "file",
        data: "https://files.invalid/undeclared?token=SECRET",
      }),
    ),
  ).rejects.toThrow(/undeclared file URL/);
});

it("scrubs declared URLs embedded in evidence text and flags unknown signed URLs", async () => {
  const signed = "https://files.invalid/a?token=KNOWN_SECRET";
  const captured = await createCapturedFiles([signed], async () => ({
    bytes: new Uint8Array([1]),
    mediaType: "image/png",
  }));
  const unknown = vi.fn();
  const sanitizer = captured.evidenceSanitizer(unknown);
  const native = {
    prompt: `Open ${signed} then https://other.invalid/b?token=UNKNOWN_SECRET`,
    tool: { result: signed },
  };
  const persisted = sanitizer.replace(native);
  expect(native.prompt).toContain("KNOWN_SECRET");
  expect(persisted.prompt).toContain(captured.referenceFor(signed));
  expect(persisted.tool.result).toBe(captured.referenceFor(signed));
  expect(JSON.stringify(persisted)).not.toMatch(/KNOWN_SECRET|UNKNOWN_SECRET/);
  expect(unknown).toHaveBeenCalledTimes(1);
});

it("preserves Date and bytes through signed URL evidence projection", async () => {
  const signed = "https://files.invalid/photo?token=SECRET";
  const captured = await createCapturedFiles([signed], async () => ({
    bytes: new Uint8Array([0, 255]),
    mediaType: "image/png",
  }));
  const unknown = vi.fn();
  const date = new Date("2025-01-01T00:00:00.000Z");
  const bytes = new Uint8Array([1, 0, 255]);
  const value = captured.evidenceSanitizer(unknown).replace({
    date,
    bytes,
    url: signed,
  });
  expect(decodeMemoryValue(encodeMemoryValue(value))).toEqual({
    date,
    bytes,
    url: captured.referenceFor(signed),
  });
  expect(unknown).not.toHaveBeenCalled();
  const unsupported = captured.evidenceSanitizer(unknown).replace({
    value: new Map([["key", signed]]),
  });
  expect(unsupported.value).toBe("[unrecordable evidence value]");
  expect(unknown).toHaveBeenCalledOnce();
});

it("rejects altered file bytes and hides resolver errors containing URL secrets", async () => {
  const url = "https://files.invalid/a?token=SECRET";
  const captured = await createCapturedFiles([url], async () => ({
    bytes: new Uint8Array([1]),
    mediaType: "image/png",
  }));
  const file = captured.files[0];
  if (!file) throw new Error("Missing captured file");
  file.bytes[0] = 2;
  expect(() => restoreCapturedFiles(captured.files)).toThrow(
    /invalid recorded file/,
  );
  await expect(
    createCapturedFiles([url], async () => {
      throw new Error(`Failed to fetch ${url}`);
    }),
  ).rejects.toThrow(/^Controlled file capture failed\.$/);
});

it("rejects cyclic or accessor-backed replay input without reading the accessor", async () => {
  const captured = await createCapturedFiles([], async () => {
    throw new Error("unexpected resolver call");
  });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(() => captured.replaceDeclaredFileUrls(cycle)).toThrow(/circular/);
  const getter = vi.fn(() => "https://files.invalid/a?token=SECRET");
  const part = Object.defineProperty({ type: "file" }, "data", {
    enumerable: true,
    get: getter,
  });
  expect(() => captured.replaceDeclaredFileUrls(part)).toThrow(/accessor/);
  expect(getter).not.toHaveBeenCalled();
});

it("rejects a file over 8 MiB before copying it", async () => {
  const bytes = new Uint8Array(8 * 1024 * 1024 + 1);
  await expect(
    createCapturedFiles(["https://files.invalid/large"], async () => ({
      bytes,
      mediaType: "application/pdf",
    })),
  ).rejects.toThrow(/8 MiB/);
  expect(() =>
    restoreCapturedFiles([
      {
        url: fileReference({ bytes, mediaType: "application/pdf" }),
        bytes,
        mediaType: "application/pdf",
      },
    ]),
  ).toThrow(/invalid recorded file/);
});

it("rejects more than 16 MiB or 64 declared files before retaining them", async () => {
  const bytes = new Uint8Array(6 * 1024 * 1024);
  const resolveFile = vi.fn(async () => ({ bytes, mediaType: "image/png" }));
  await expect(
    createCapturedFiles(
      [
        "https://files.invalid/1",
        "https://files.invalid/2",
        "https://files.invalid/3",
      ],
      resolveFile,
    ),
  ).rejects.toThrow(/16 MiB/);
  expect(resolveFile).toHaveBeenCalledTimes(3);
  resolveFile.mockClear();
  await expect(
    createCapturedFiles(
      Array.from(
        { length: 65 },
        (_, index) => `https://files.invalid/${index}`,
      ),
      resolveFile,
    ),
  ).rejects.toThrow(/count limit/);
  expect(resolveFile).not.toHaveBeenCalled();
});
