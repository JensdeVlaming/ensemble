import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RepositoryRef, Task, Workspace } from "../domain/model.ts";
import { ProcessTerminationUnconfirmedError, runBoundedProcess } from "./process.ts";

const MANIFEST_VERSION = 1;
const MANIFEST_NAME = "workspace.json";
const MANIFEST_MAX_BYTES = 16_384;
const QUARANTINE_PREFIX = ".ensemble-quarantine-";
const MANAGED_NAME_PATTERN = /--[a-f0-9]{20}$/u;

export interface RepositoryDriver {
  materialize(repository: RepositoryRef, target: string): Promise<void>;
  refresh?(repository: RepositoryRef, target: string): Promise<void>;
}

export class GitRepositoryDriver implements RepositoryDriver {
  readonly executable: string;
  readonly timeoutMs: number;

  constructor(executable = "git", timeoutMs = 60_000) {
    this.executable = executable;
    this.timeoutMs = timeoutMs;
  }

  async materialize(repository: RepositoryRef, target: string): Promise<void> {
    const branch = repository.branch ?? repository.defaultBranch;
    const arguments_ = ["clone", "--no-tags"];
    if (branch) arguments_.push("--branch", branch, "--single-branch");
    arguments_.push("--", repository.url, target);
    await runProcess(this.executable, arguments_, { timeoutMs: this.timeoutMs });
  }

  async refresh(repository: RepositoryRef, target: string): Promise<void> {
    const origin = (await runProcess(this.executable, ["-C", target, "remote", "get-url", "origin"],
      { timeoutMs: this.timeoutMs })).stdout.trim();
    if (origin !== repository.url) throw new Error("Repository origin does not match configured identity");
    const branch = repository.branch ?? repository.defaultBranch;
    if (!branch) {
      await runProcess(this.executable, ["-C", target, "fetch", "--no-tags", "origin"], { timeoutMs: this.timeoutMs });
      return;
    }
    const current = (await runProcess(this.executable, ["-C", target, "branch", "--show-current"],
      { timeoutMs: this.timeoutMs })).stdout.trim();
    if (current !== branch) throw new Error("Repository branch does not match configured identity");
    await runProcess(this.executable, ["-C", target, "fetch", "--no-tags", "origin", branch], { timeoutMs: this.timeoutMs });
    const [head, fetched, base, status] = await Promise.all([
      runProcess(this.executable, ["-C", target, "rev-parse", "HEAD"], { timeoutMs: this.timeoutMs }),
      runProcess(this.executable, ["-C", target, "rev-parse", "FETCH_HEAD"], { timeoutMs: this.timeoutMs }),
      runProcess(this.executable, ["-C", target, "merge-base", "HEAD", "FETCH_HEAD"], { timeoutMs: this.timeoutMs }),
      runProcess(this.executable, ["-C", target, "status", "--porcelain=v1", "--untracked-files=normal"], { timeoutMs: this.timeoutMs }),
    ]);
    const headId = head.stdout.trim();
    const fetchedId = fetched.stdout.trim();
    if (!status.stdout && base.stdout.trim() === headId && headId !== fetchedId) {
      await runProcess(this.executable, ["-C", target, "merge", "--ff-only", "FETCH_HEAD"], { timeoutMs: this.timeoutMs });
    }
  }
}

export interface LegacyWorkspaceHandle {
  readonly id: string;
}

export interface ManagedWorkspaceHandle {
  readonly id: string;
}

export type LegacyWorkspaceMatch =
  | { readonly kind: "unique"; readonly handle: LegacyWorkspaceHandle; readonly taskId: string }
  | { readonly kind: "ambiguous"; readonly handle: LegacyWorkspaceHandle }
  | { readonly kind: "unmatched"; readonly handle: LegacyWorkspaceHandle };

export type ManagedWorkspaceMatch =
  | { readonly kind: "unique"; readonly handle: ManagedWorkspaceHandle; readonly taskId: string }
  | { readonly kind: "unmatched"; readonly handle: ManagedWorkspaceHandle }
  | { readonly kind: "invalid"; readonly handle: ManagedWorkspaceHandle };

export interface WorkspaceManager {
  create(task: Task): Promise<Workspace>;
  restore(task: Task): Promise<Workspace | undefined>;
  cleanup(workspace: Workspace, options?: WorkspaceCleanupOptions): Promise<void>;
  validate?(workspace: Workspace): Promise<void>;
  classifyLegacy?(tasks: readonly Task[]): Promise<readonly LegacyWorkspaceMatch[]>;
  classifyManaged?(tasks: readonly Task[]): Promise<readonly ManagedWorkspaceMatch[]>;
  migrateLegacy?(match: Extract<LegacyWorkspaceMatch, { kind: "unique" }>, task: Task): Promise<Workspace>;
  quarantineLegacy?(handle: LegacyWorkspaceHandle): Promise<void>;
  removeLegacy?(handle: LegacyWorkspaceHandle, options?: WorkspaceRemovalOptions): Promise<void>;
  quarantineManaged?(handle: ManagedWorkspaceHandle): Promise<void>;
  removeManaged?(handle: ManagedWorkspaceHandle, options?: WorkspaceRemovalOptions): Promise<void>;
  removeTask?(task: Task, options?: WorkspaceRemovalOptions): Promise<void>;
}

export interface WorkspaceCleanupOptions {
  readonly beforeRemove?: () => Promise<void>;
}

export interface WorkspaceRemovalOptions {
  readonly beforeRemove?: (workspace: Workspace) => Promise<void>;
}

interface WorkspaceManifest {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly taskId: string;
  readonly repository: RepositoryRef;
}

interface EntryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface WorkspaceRegistration {
  readonly manifest: WorkspaceManifest;
  readonly root: EntryIdentity;
  readonly repository: EntryIdentity;
  readonly runtime: EntryIdentity;
}

interface BaseIdentity extends EntryIdentity {
  readonly realPath: string;
}

/** Local workspace storage with namespaced identities and fail-closed containment. */
export class LocalWorkspaceManager implements WorkspaceManager {
  readonly #basePath: string;
  readonly #repositories: RepositoryDriver;
  readonly #preserve: boolean;
  readonly #namespace: string;
  readonly #legacy = new Map<string, { readonly path: string; readonly identity: EntryIdentity }>();
  readonly #managed = new Map<string, {
    readonly workspace: Workspace;
    readonly identity: EntryIdentity;
    readonly registration?: WorkspaceRegistration;
  }>();
  readonly #registrations = new Map<string, WorkspaceRegistration>();
  #baseIdentity?: BaseIdentity;

  constructor(
    basePath: string,
    repositories: RepositoryDriver,
    preserve = true,
    namespace = "local",
  ) {
    if (!isAbsolute(basePath)) throw new Error(`Workspace root must be absolute: ${basePath}`);
    if (!namespace.trim() || Buffer.byteLength(namespace, "utf8") > 512) throw new Error("Workspace namespace is invalid");
    this.#basePath = resolve(basePath);
    this.#repositories = repositories;
    this.#preserve = preserve;
    this.#namespace = namespace;
  }

  async create(task: Task): Promise<Workspace> {
    await this.#prepareBase();
    const workspace = this.#workspace(task.id);
    await this.#assertContained(workspace.root, false);
    let ownsRoot = false;
    let rootIdentity: EntryIdentity | undefined;
    try {
      await mkdir(workspace.root, { mode: 0o700 });
      ownsRoot = true;
      await this.#assertContained(workspace.root, true);
      rootIdentity = await entryIdentity(workspace.root);
      await mkdir(workspace.runtimePath, { mode: 0o700 });
      await this.#assertEntryIdentity(workspace.root, rootIdentity);
      await this.#assertContained(workspace.runtimePath, true);
      await this.#assertContained(workspace.repositoryPath, false);
      await this.#repositories.materialize(task.repository, workspace.repositoryPath);
      await this.#assertEntryIdentity(workspace.root, rootIdentity);
      await this.#writeManifest(workspace, task);
      const registration = await this.#validateWorkspace(workspace, task);
      this.#registrations.set(workspace.root, registration);
      return workspace;
    } catch (error) {
      if (ownsRoot) await this.#removeRoot(workspace.root, rootIdentity).catch(() => undefined);
      throw error;
    }
  }

  async restore(task: Task): Promise<Workspace | undefined> {
    await this.#prepareBase();
    const workspace = this.#workspace(task.id);
    try {
      const registration = await this.#validateWorkspace(workspace, task);
      await this.#repositories.refresh?.(task.repository, workspace.repositoryPath);
      await this.#validateRegistration(workspace, registration);
      this.#registrations.set(workspace.root, registration);
      return workspace;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async validate(workspace: Workspace): Promise<void> {
    await this.#prepareBase();
    await this.#assertWorkspaceShape(workspace);
    const expected = this.#registrations.get(workspace.root);
    if (!expected) throw new Error("Workspace was not allocated by this manager");
    await this.#validateRegistration(workspace, expected);
  }

  async cleanup(workspace: Workspace, options: WorkspaceCleanupOptions = {}): Promise<void> {
    if (this.#preserve) return;
    await this.#prepareBase();
    await this.#assertWorkspaceShape(workspace);
    const expected = this.#registrations.get(workspace.root);
    if (!expected) throw new Error("Workspace was not allocated by this manager");
    await this.#validateRegistration(workspace, expected);
    await options.beforeRemove?.().catch((error: unknown) => {
      if (error instanceof ProcessTerminationUnconfirmedError) throw error;
    });
    await this.#validateRegistration(workspace, expected);
    await this.#removeRoot(workspace.root, expected.root);
    this.#registrations.delete(workspace.root);
  }

  async classifyLegacy(tasks: readonly Task[]): Promise<readonly LegacyWorkspaceMatch[]> {
    await this.#prepareBase();
    this.#legacy.clear();
    const byHistoricalName = new Map<string, Task[]>();
    for (const task of tasks) {
      let name: string;
      try { name = historicalSegment(task.id); }
      catch { continue; }
      const matches = byHistoricalName.get(name) ?? [];
      matches.push(task);
      byHistoricalName.set(name, matches);
    }
    const entries = (await readdir(this.#basePath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(QUARANTINE_PREFIX))
      .sort((left, right) => left.name.localeCompare(right.name));
    const results: LegacyWorkspaceMatch[] = [];
    for (const entry of entries) {
      const root = join(this.#basePath, entry.name);
      await this.#assertContained(root, true);
      if (await manifestExists(root) || MANAGED_NAME_PATTERN.test(entry.name)) continue;
      const handle = Object.freeze({ id: randomUUID() });
      this.#legacy.set(handle.id, { path: root, identity: await entryIdentity(root) });
      const candidates = byHistoricalName.get(entry.name) ?? [];
      results.push(candidates.length === 1
        ? Object.freeze({ kind: "unique", handle, taskId: candidates[0]!.id })
        : candidates.length > 1
          ? Object.freeze({ kind: "ambiguous", handle })
          : Object.freeze({ kind: "unmatched", handle }));
    }
    return Object.freeze(results);
  }

  async classifyManaged(tasks: readonly Task[]): Promise<readonly ManagedWorkspaceMatch[]> {
    await this.#prepareBase();
    this.#managed.clear();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const entries = (await readdir(this.#basePath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(QUARANTINE_PREFIX))
      .sort((left, right) => left.name.localeCompare(right.name));
    const results: ManagedWorkspaceMatch[] = [];
    for (const entry of entries) {
      const root = join(this.#basePath, entry.name);
      if (!await manifestExists(root) && !MANAGED_NAME_PATTERN.test(entry.name)) continue;
      const workspace = Object.freeze({ root, repositoryPath: join(root, "repository"), runtimePath: join(root, ".ensemble-runtime") });
      const handle = Object.freeze({ id: randomUUID() });
      const identity = await entryIdentity(root);
      try {
        await this.#assertContained(root, true);
        await this.#assertRepositoryDirectories(workspace);
        const manifest = await this.#readManifest(workspace);
        const task = byId.get(manifest.taskId);
        if (manifest.namespace !== this.#namespace || (task && !sameRepository(manifest.repository, task.repository))) {
          this.#managed.set(handle.id, { workspace, identity });
          results.push(Object.freeze({ kind: "invalid", handle }));
          continue;
        }
        const [repositoryIdentity, runtimeIdentity] = await Promise.all([
          entryIdentity(workspace.repositoryPath), entryIdentity(workspace.runtimePath),
        ]);
        const registration = Object.freeze({ manifest, root: identity, repository: repositoryIdentity, runtime: runtimeIdentity });
        this.#managed.set(handle.id, { workspace, identity, registration });
        results.push(task ? Object.freeze({ kind: "unique", handle, taskId: task.id })
          : Object.freeze({ kind: "unmatched", handle }));
      } catch {
        this.#managed.set(handle.id, { workspace, identity });
        results.push(Object.freeze({ kind: "invalid", handle }));
      }
    }
    return Object.freeze(results);
  }

  async migrateLegacy(match: Extract<LegacyWorkspaceMatch, { kind: "unique" }>, task: Task): Promise<Workspace> {
    if (match.taskId !== task.id) throw new Error("Legacy workspace task identity mismatch");
    await this.#prepareBase();
    const legacy = this.#takeLegacy(match.handle);
    const source = legacy.path;
    await this.#assertContained(source, true);
    await this.#assertEntryIdentity(source, legacy.identity);
    const workspace = this.#workspace(task.id);
    await this.#assertContained(workspace.root, false);
    await rename(source, workspace.root);
    try {
      await this.#assertContained(workspace.root, true);
      await this.#assertEntryIdentity(workspace.root, legacy.identity);
      await this.#assertRepositoryDirectories(workspace);
      await this.#writeManifest(workspace, task);
      const registration = await this.#validateWorkspace(workspace, task);
      this.#registrations.set(workspace.root, registration);
      return workspace;
    } catch (error) {
      await rename(workspace.root, source).catch(() => undefined);
      throw error;
    }
  }

  async quarantineLegacy(handle: LegacyWorkspaceHandle): Promise<void> {
    await this.#prepareBase();
    const legacy = this.#takeLegacy(handle);
    const source = legacy.path;
    await this.#assertContained(source, true);
    await this.#assertEntryIdentity(source, legacy.identity);
    const target = join(this.#basePath, `${QUARANTINE_PREFIX}${handle.id}`);
    await this.#assertContained(target, false);
    await rename(source, target);
    await this.#assertContained(target, true);
    await this.#assertEntryIdentity(target, legacy.identity);
  }

  async removeLegacy(handle: LegacyWorkspaceHandle, options: WorkspaceRemovalOptions = {}): Promise<void> {
    await this.#prepareBase();
    const legacy = this.#takeLegacy(handle);
    const workspace = Object.freeze({ root: legacy.path, repositoryPath: join(legacy.path, "repository"),
      runtimePath: join(legacy.path, ".ensemble-runtime") });
    if (options.beforeRemove) {
      let hookSafe = true;
      try {
        await this.#assertEntryIdentity(legacy.path, legacy.identity);
        await this.#assertRepositoryDirectories(workspace);
      } catch { hookSafe = false; }
      if (hookSafe) await options.beforeRemove(workspace).catch((error: unknown) => {
        if (error instanceof ProcessTerminationUnconfirmedError) throw error;
      });
    }
    await this.#assertEntryIdentity(legacy.path, legacy.identity);
    await this.#removeRoot(legacy.path, legacy.identity);
  }

  async quarantineManaged(handle: ManagedWorkspaceHandle): Promise<void> {
    await this.#prepareBase();
    const managed = this.#takeManaged(handle);
    await this.#assertContained(managed.workspace.root, true);
    await this.#assertEntryIdentity(managed.workspace.root, managed.identity);
    const target = join(this.#basePath, `${QUARANTINE_PREFIX}${handle.id}`);
    await this.#assertContained(target, false);
    await rename(managed.workspace.root, target);
    await this.#assertEntryIdentity(target, managed.identity);
  }

  async removeManaged(handle: ManagedWorkspaceHandle, options: WorkspaceRemovalOptions = {}): Promise<void> {
    await this.#prepareBase();
    const managed = this.#takeManaged(handle);
    if (managed.registration) await this.#validateRegistration(managed.workspace, managed.registration);
    else await this.#assertEntryIdentity(managed.workspace.root, managed.identity);
    await options.beforeRemove?.(managed.workspace).catch((error: unknown) => {
      if (error instanceof ProcessTerminationUnconfirmedError) throw error;
    });
    await this.#removeRoot(managed.workspace.root, managed.identity);
    this.#registrations.delete(managed.workspace.root);
  }

  async removeTask(task: Task, options: WorkspaceRemovalOptions = {}): Promise<void> {
    await this.#prepareBase();
    const workspace = this.#workspace(task.id);
    let expected: WorkspaceRegistration;
    try { expected = await this.#validateWorkspace(workspace, task); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    await options.beforeRemove?.(workspace).catch((error: unknown) => {
      if (error instanceof ProcessTerminationUnconfirmedError) throw error;
    });
    await this.#validateRegistration(workspace, expected);
    await this.#removeRoot(workspace.root, expected.root);
    this.#registrations.delete(workspace.root);
  }

  async #prepareBase(): Promise<void> {
    await mkdir(this.#basePath, { recursive: true, mode: 0o700 });
    const base = await lstat(this.#basePath);
    const currentUid = process.getuid?.();
    if (!base.isDirectory() || base.isSymbolicLink() || (base.mode & 0o022) !== 0
      || (currentUid !== undefined && base.uid !== currentUid)) throw new Error("Workspace root ownership or permissions are unsafe");
    const identity = { dev: base.dev, ino: base.ino, realPath: await realpath(this.#basePath) };
    if (this.#baseIdentity && !sameEntry(this.#baseIdentity, identity)) throw new Error("Workspace root identity changed");
    if (this.#baseIdentity && this.#baseIdentity.realPath !== identity.realPath) throw new Error("Workspace root canonical path changed");
    this.#baseIdentity ??= Object.freeze(identity);
  }

  #workspace(taskId: string): Workspace {
    const root = join(this.#basePath, workspaceSegment(this.#namespace, taskId));
    this.#assertDirectChild(root);
    return Object.freeze({ root, repositoryPath: join(root, "repository"), runtimePath: join(root, ".ensemble-runtime") });
  }

  async #validateWorkspace(workspace: Workspace, task: Task): Promise<WorkspaceRegistration> {
    await this.#assertWorkspaceShape(workspace);
    await this.#assertContained(workspace.root, true);
    await this.#assertRepositoryDirectories(workspace);
    const manifest = await this.#readManifest(workspace);
    if (manifest.namespace !== this.#namespace || manifest.taskId !== task.id
      || !sameRepository(manifest.repository, task.repository)) throw new Error("Workspace manifest identity mismatch");
    const [root, repository, runtime] = await Promise.all([
      entryIdentity(workspace.root), entryIdentity(workspace.repositoryPath), entryIdentity(workspace.runtimePath),
    ]);
    return Object.freeze({ manifest, root, repository, runtime });
  }

  async #validateRegistration(workspace: Workspace, expected: WorkspaceRegistration): Promise<void> {
    await this.#assertEntryIdentity(workspace.root, expected.root);
    await this.#assertEntryIdentity(workspace.repositoryPath, expected.repository);
    await this.#assertEntryIdentity(workspace.runtimePath, expected.runtime);
    await this.#assertRepositoryDirectories(workspace);
    const manifest = await this.#readManifest(workspace);
    if (!sameManifest(manifest, expected.manifest)) throw new Error("Workspace manifest identity changed");
    await this.#assertEntryIdentity(workspace.runtimePath, expected.runtime);
    await this.#assertEntryIdentity(workspace.repositoryPath, expected.repository);
    await this.#assertEntryIdentity(workspace.root, expected.root);
  }

  async #assertWorkspaceShape(workspace: Workspace): Promise<void> {
    const root = resolve(workspace.root);
    this.#assertDirectChild(root);
    if (workspace.root !== root || workspace.repositoryPath !== join(root, "repository")
      || workspace.runtimePath !== join(root, ".ensemble-runtime")) throw new Error("Workspace paths do not match the managed layout");
  }

  async #assertRepositoryDirectories(workspace: Workspace): Promise<void> {
    const root = await lstat(workspace.root);
    for (const path of [workspace.root, workspace.repositoryPath, workspace.runtimePath]) {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== root.uid || (entry.mode & 0o022) !== 0) {
        throw new Error("Workspace contains an invalid directory boundary");
      }
      await this.#assertContained(path, true);
    }
  }

  async #writeManifest(workspace: Workspace, task: Task): Promise<void> {
    const manifest: WorkspaceManifest = Object.freeze({
      schemaVersion: MANIFEST_VERSION,
      namespace: this.#namespace,
      taskId: task.id,
      repository: Object.freeze({ ...task.repository }),
    });
    const serialized = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MANIFEST_MAX_BYTES) throw new Error("Workspace manifest is too large");
    const target = join(workspace.runtimePath, MANIFEST_NAME);
    const temporary = join(workspace.runtimePath, `.${MANIFEST_NAME}.${randomUUID()}.tmp`);
    await this.#assertContained(workspace.runtimePath, true);
    const runtimeIdentity = await entryIdentity(workspace.runtimePath);
    try {
      await this.#assertEntryIdentity(workspace.runtimePath, runtimeIdentity);
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY });
      await this.#assertEntryIdentity(workspace.runtimePath, runtimeIdentity);
      await rename(temporary, target);
      await this.#assertEntryIdentity(workspace.runtimePath, runtimeIdentity);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #readManifest(workspace: Workspace): Promise<WorkspaceManifest> {
    const path = join(workspace.runtimePath, MANIFEST_NAME);
    await this.#assertContained(workspace.runtimePath, true);
    const [entry, root] = await Promise.all([lstat(path), lstat(workspace.root)]);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MANIFEST_MAX_BYTES || (entry.mode & 0o777) !== 0o600
      || entry.uid !== root.uid) throw new Error("Workspace manifest file is unsafe");
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MANIFEST_MAX_BYTES) throw new Error("Workspace manifest is too large");
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error("Workspace manifest is invalid"); }
    return validateManifest(value);
  }

  async #assertContained(path: string, mustExist: boolean): Promise<void> {
    await this.#assertBaseStable();
    const target = resolve(path);
    this.#assertDirectDescendant(target);
    const parent = dirname(target);
    const parentReal = await realpath(parent);
    const baseReal = this.#baseIdentity!.realPath;
    if (parentReal !== baseReal && !parentReal.startsWith(`${baseReal}${sep}`)) throw new Error("Workspace path escapes its configured root");
    try {
      const entry = await lstat(target);
      if (entry.isSymbolicLink()) throw new Error("Workspace path must not be a symbolic link");
      const targetReal = await realpath(target);
      if (!targetReal.startsWith(`${baseReal}${sep}`)) throw new Error("Workspace path escapes its configured root");
    } catch (error) {
      if (!mustExist && (error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.#assertBaseStable();
        return;
      }
      throw error;
    }
    await this.#assertBaseStable();
  }

  async #removeRoot(root: string, expected?: EntryIdentity): Promise<void> {
    await this.#assertContained(root, true);
    this.#assertDirectChild(root);
    if (expected) await this.#assertEntryIdentity(root, expected);
    await rm(root, { recursive: true, force: true });
  }

  #takeLegacy(handle: LegacyWorkspaceHandle): { readonly path: string; readonly identity: EntryIdentity } {
    const entry = this.#legacy.get(handle.id);
    if (!entry) throw new Error("Legacy workspace handle is invalid or already used");
    this.#legacy.delete(handle.id);
    return entry;
  }

  #takeManaged(handle: ManagedWorkspaceHandle): {
    readonly workspace: Workspace;
    readonly identity: EntryIdentity;
    readonly registration?: WorkspaceRegistration;
  } {
    const entry = this.#managed.get(handle.id);
    if (!entry) throw new Error("Managed workspace handle is invalid or already used");
    this.#managed.delete(handle.id);
    return entry;
  }

  async #assertBaseStable(): Promise<void> {
    const expected = this.#baseIdentity;
    if (!expected) throw new Error("Workspace root is not initialized");
    const entry = await lstat(this.#basePath);
    const currentUid = process.getuid?.();
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o022) !== 0
      || (currentUid !== undefined && entry.uid !== currentUid) || !sameEntry(entry, expected)
      || await realpath(this.#basePath) !== expected.realPath) throw new Error("Workspace root identity changed");
  }

  async #assertEntryIdentity(path: string, expected: EntryIdentity): Promise<void> {
    await this.#assertBaseStable();
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !sameEntry(entry, expected)) throw new Error("Workspace filesystem identity changed");
    await this.#assertBaseStable();
  }

  #assertDirectChild(path: string): void {
    const child = relative(this.#basePath, path);
    if (!child || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child) || child.includes(sep)) {
      throw new Error(`Workspace path must be a direct child of the configured root: ${path}`);
    }
  }

  #assertDirectDescendant(path: string): void {
    const child = relative(this.#basePath, path);
    if (!child || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child)) {
      throw new Error(`Workspace path must be contained by the configured root: ${path}`);
    }
  }
}

function workspaceSegment(namespace: string, taskId: string): string {
  const readable = readableSegment(taskId);
  const digest = createHash("sha256").update(namespace).update("\0").update(taskId).digest("hex").slice(0, 20);
  return `${readable}--${digest}`;
}

function readableSegment(id: string): string {
  const value = id.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "").slice(0, 40);
  return value || "task";
}

function historicalSegment(id: string): string {
  const value = id.toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  if (!value) throw new Error(`Task id cannot form a legacy workspace name: ${id}`);
  return value;
}

async function manifestExists(root: string): Promise<boolean> {
  try { await lstat(join(root, ".ensemble-runtime", MANIFEST_NAME)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function validateManifest(value: unknown): WorkspaceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !hasExactKeys(value, ["schemaVersion", "namespace", "taskId", "repository"])) throw new Error("Workspace manifest is invalid");
  const manifest = value as Partial<WorkspaceManifest>;
  if (manifest.schemaVersion !== MANIFEST_VERSION || typeof manifest.namespace !== "string" || !manifest.namespace
    || typeof manifest.taskId !== "string" || !manifest.taskId || !isRepository(manifest.repository)) {
    throw new Error("Workspace manifest is invalid");
  }
  return Object.freeze({ schemaVersion: MANIFEST_VERSION, namespace: manifest.namespace, taskId: manifest.taskId,
    repository: Object.freeze({ ...manifest.repository }) });
}

function isRepository(value: unknown): value is RepositoryRef {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !hasOnlyKeys(value, ["id", "url", "defaultBranch", "branch"])) return false;
  const repository = value as Partial<RepositoryRef>;
  return typeof repository.id === "string" && !!repository.id && typeof repository.url === "string" && !!repository.url
    && (repository.defaultBranch === undefined || typeof repository.defaultBranch === "string")
    && (repository.branch === undefined || typeof repository.branch === "string");
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

function sameRepository(left: RepositoryRef, right: RepositoryRef): boolean {
  return left.id === right.id && left.url === right.url && left.defaultBranch === right.defaultBranch && left.branch === right.branch;
}

function sameManifest(left: WorkspaceManifest, right: WorkspaceManifest): boolean {
  return left.schemaVersion === right.schemaVersion && left.namespace === right.namespace && left.taskId === right.taskId
    && sameRepository(left.repository, right.repository);
}

async function entryIdentity(path: string): Promise<EntryIdentity> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) throw new Error("Workspace filesystem identity is unsafe");
  return Object.freeze({ dev: entry.dev, ino: entry.ino });
}

function sameEntry(left: EntryIdentity, right: EntryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

interface ProcessResult {
  readonly stdout: string;
}

function runProcess(
  executable: string,
  arguments_: readonly string[],
  options: { readonly timeoutMs: number },
): Promise<ProcessResult> {
  return runBoundedProcess({
    executable,
    args: arguments_,
    env: gitEnvironment(),
    timeoutMs: options.timeoutMs,
    outputLimit: 65_536,
    label: "Repository command",
  });
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "GIT_ASKPASS"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}
