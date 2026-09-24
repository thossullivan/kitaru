import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  MastraExclusiveMemoryAccess,
  MastraMemoryLease,
  MastraMemoryLeaseOptions,
  MastraMemorySelector,
} from "../../src/memory-binding.js";

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

/** Test-only shared lease: atomic directory creation and persistent poison. */
export function createFileMemoryAccess(
  root: string,
): MastraExclusiveMemoryAccess & {
  simulateLeaseLoss(selector: MastraMemorySelector): Promise<void>;
} {
  function directory(selector: MastraMemorySelector): string {
    return join(
      root,
      createHash("sha256").update(selector.threadId).digest("hex"),
    );
  }
  const globalPoison = join(root, "unknown-writer-poison");

  async function withMutex<T>(
    selector: MastraMemorySelector,
    run: (dir: string) => Promise<T>,
  ): Promise<T> {
    const dir = directory(selector);
    await mkdir(dir, { recursive: true });
    const mutex = join(dir, "mutex");
    const deadline = Date.now() + 1000;
    while (true) {
      try {
        await mkdir(mutex);
        break;
      } catch (error) {
        if (!isExists(error) || Date.now() >= deadline) throw error;
        await pause(2);
      }
    }
    try {
      return await run(dir);
    } finally {
      await rm(mutex, { recursive: true, force: true });
    }
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    }
  }

  async function poison(dir: string, persistent: boolean): Promise<void> {
    const marker = join(dir, persistent ? "persistent-loss" : "poison");
    try {
      const file = await open(marker, "wx");
      await file.close();
    } catch (error) {
      if (!isExists(error)) throw error;
    }
    if (persistent) await poison(dir, false);
  }

  async function activeTurns(dir: string): Promise<string[]> {
    const names = await readdir(dir);
    return names.filter((name) => name.startsWith("turn-"));
  }

  async function makeLease(
    selector: MastraMemorySelector,
    token: string,
    owns: boolean,
  ): Promise<MastraMemoryLease> {
    let released = false;
    const release = async () => {
      if (released) return;
      await withMutex(selector, async (dir) => {
        if (owns) {
          const current = await readFile(join(dir, "owner"), "utf8").catch(
            () => undefined,
          );
          if (current === token) await rm(join(dir, "owner"), { force: true });
        } else {
          await rm(join(dir, `turn-${token}`), { force: true });
        }
        if (
          !(await exists(join(dir, "owner"))) &&
          (await activeTurns(dir)).length === 0 &&
          !(await exists(join(dir, "persistent-loss")))
        )
          await rm(join(dir, "poison"), { force: true });
      });
      released = true;
    };
    return Object.assign(release, {
      async verifyEligibility() {
        if (released || !owns) return false;
        return withMutex(selector, async (dir) => {
          if (
            (await exists(globalPoison)) ||
            (await exists(join(dir, "poison")))
          )
            return false;
          return (await readFile(join(dir, "owner"), "utf8")) === token;
        });
      },
    });
  }

  return {
    async acquire(selector, options: MastraMemoryLeaseOptions = {}) {
      const waitMs = options.waitMs ?? 100;
      const deadline = Date.now() + waitMs;
      const token = randomUUID();
      while (true) {
        if (options.signal?.aborted)
          throw new Error("Source-thread lease wait cancelled.");
        const status = await withMutex(selector, async (dir) => {
          if (
            (await exists(globalPoison)) ||
            (await exists(join(dir, "poison")))
          ) {
            await writeFile(join(dir, `turn-${token}`), "");
            return "denied";
          }
          if (await exists(join(dir, "owner"))) return "busy";
          await writeFile(join(dir, "owner"), token, { flag: "wx" });
          return "owned";
        });
        if (status === "owned") return makeLease(selector, token, true);
        if (status === "denied") return makeLease(selector, token, false);
        if (Date.now() >= deadline) {
          await withMutex(selector, async (dir) => {
            await poison(dir, false);
            await writeFile(join(dir, `turn-${token}`), "");
          });
          return makeLease(selector, token, false);
        }
        await pause(Math.min(5, deadline - Date.now()));
      }
    },
    async markUnsafeWrite(selector) {
      if (!selector) {
        await writeFile(globalPoison, "unsafe write");
        return;
      }
      await withMutex(selector, async (dir) => {
        await poison(dir, true);
      });
    },
    async resetAfterQuiescence(selector) {
      if (!selector) {
        for (const name of await readdir(root)) {
          if (name === "unknown-writer-poison") continue;
          const dir = join(root, name);
          if (
            (await exists(join(dir, "owner"))) ||
            (await activeTurns(dir)).length > 0
          )
            throw new Error("Source-thread writers are still active.");
        }
        await rm(globalPoison, { force: true });
        return;
      }
      await withMutex(selector, async (dir) => {
        if (
          (await exists(join(dir, "owner"))) ||
          (await activeTurns(dir)).length > 0
        )
          throw new Error("Source-thread writers are still active.");
        await rm(join(dir, "persistent-loss"), { force: true });
        await rm(join(dir, "poison"), { force: true });
      });
    },
    async simulateLeaseLoss(selector) {
      await withMutex(selector, async (dir) => {
        await poison(dir, true);
        await rm(join(dir, "owner"), { force: true });
      });
    },
  };
}
