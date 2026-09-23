import { expect, it, vi } from "vitest";
import {
  createCapturedFiles,
  restoreCapturedFiles,
} from "../src/stateful-files.js";

it("preloads once and supplies independent historical bytes without network fallback", async () => {
  const resolver = vi.fn(async () => ({
    bytes: new Uint8Array([0, 255, 1]),
    mediaType: "application/pdf",
  }));
  const captured = await createCapturedFiles(
    ["https://files.invalid/a", "https://files.invalid/a"],
    resolver,
  );
  const replay = restoreCapturedFiles(captured.files);
  (await captured.resolveFile("https://files.invalid/a")).bytes[0] = 9;
  expect((await replay.resolveFile("https://files.invalid/a")).bytes).toEqual(
    new Uint8Array([0, 255, 1]),
  );
  await expect(
    replay.resolveFile("https://files.invalid/missing"),
  ).rejects.toThrow(/not recorded/);
  expect(resolver).toHaveBeenCalledTimes(1);
});
