import { randomUUID } from "node:crypto";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface InstanceGuard {
  readonly path: string;
  release(): Promise<void>;
}

export async function acquireInstanceGuard(statePath: string): Promise<InstanceGuard> {
  if (!isAbsolute(statePath)) throw new Error(`State path must be absolute: ${statePath}`);
  const path = join(statePath, "service.lock");
  const token = `${process.pid}:${randomUUID()}`;
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const details = await lstat(path).catch(() => undefined);
    if (!details?.isFile() || details.isSymbolicLink()) throw new Error(`Instance guard path is not a stale regular file: ${path}`);
    if (await liveOwner(path)) throw new Error(`Another Ensemble instance is already running: ${path}`);
    await unlink(path);
    handle = await open(path, "wx", 0o600);
  }
  await handle.writeFile(`${token}\n`, "utf8");
  await handle.close();
  let released = false;
  return Object.freeze({
    path,
    release: async () => {
      if (released) return;
      released = true;
      const current = await readFile(path, "utf8").catch(() => undefined);
      if (current?.trim() === token) await unlink(path);
    },
  });
}

async function liveOwner(path: string): Promise<boolean> {
  const source = await readFile(path, "utf8").catch(() => "");
  const match = /^(\d+):[0-9a-f-]+$/iu.exec(source.trim());
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
