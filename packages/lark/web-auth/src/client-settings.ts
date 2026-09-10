import Schema from "@deepseek-ai/schemastery";

type Namespace = { ns: string; value: unknown; base: unknown; user: unknown; revision: number; schema: unknown };
type View = { namespaces: Namespace[]; writable: boolean; hasDocument: boolean };
type Result<T> = { ok: true; value: T } | { ok: false; error: { message: string } };
type Op = { op: "set" | "unset"; path: string[]; value?: unknown };
type Snapshot = { status: string; view?: View; error: string | null };
export type SettingsRemote = {
  describe(): Promise<Result<View>>;
  mutate(ns: string, ops: readonly Op[], revision?: number): Promise<Result<Namespace>>;
};

/** 自有远程镜像：并发读取合流，失效期间再读一次，退出后不发布。 */
export class RemoteSettingsMirror {
  private snapshot: Snapshot = { status: "idle", error: null };
  private listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private again = false;
  private disposed = false;
  constructor(readonly remote: SettingsRemote) {}
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: Snapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  ensure = (): Promise<void> => this.pending ?? (this.snapshot.view ? Promise.resolve() : this.load());
  load = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.pending) { this.again = true; return this.pending; }
    this.pending = Promise.resolve().then(async () => {
      do {
        this.again = false;
        try {
          const result = await this.remote.describe();
          if (!result.ok) throw new Error(result.error.message);
          // 公网不提供本机编辑器操作。
          this.publish({ status: "ready", view: { ...result.value, hasDocument: false }, error: null });
        } catch (error) {
          this.publish({ ...this.snapshot, status: this.snapshot.view ? "ready" : "idle", error: String(error) });
        }
      } while (this.again && !this.disposed);
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  };
  acceptView(view: Namespace): void {
    if (this.pending) this.again = true;
    const current = this.snapshot.view;
    if (!current) return;
    const namespaces = current.namespaces.filter((entry) => entry.ns !== view.ns);
    this.publish({ status: "ready", view: { ...current, namespaces: [...namespaces, view] }, error: null });
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
}

/** 只使用 JSON 路径，阻止原型键成为设置草稿路径。 */
export class RemoteSettingsSchema {
  rehydrate(value: unknown): Schema { return new Schema(value as Schema); }
  validate(schema: Schema, value: unknown): string | undefined {
    try { schema(value); return undefined; } catch (error) { return String(error); }
  }
  nodeAtPath(root: Schema, path: readonly string[]): Schema | undefined {
    let node: Schema | undefined = root;
    for (const key of path) {
      node = node?.type === "object" ? node.dict?.[key] : node?.type === "array" || node?.type === "dict" ? node.inner : undefined;
    }
    return node;
  }
  getPath(value: unknown, path: readonly string[]): unknown {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }
  hasPath(value: unknown, path: readonly string[]): boolean {
    if (!path.length) return value !== undefined;
    const parent = this.getPath(value, path.slice(0, -1));
    return !!parent && typeof parent === "object" && Object.hasOwn(parent, path[path.length - 1]!);
  }
  private change(root: Record<string, unknown>, path: readonly string[], value: unknown, remove: boolean): Record<string, unknown> {
    if (!path.length || path.some((key) => ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("无效设置路径");
    if (remove && !this.hasPath(root, path)) return root;
    const copy = structuredClone(root);
    let parent = copy;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!;
      if (!parent[key] || typeof parent[key] !== "object") parent[key] = /^\d+$/.test(path[i + 1]!) ? [] : {};
      parent = parent[key] as Record<string, unknown>;
    }
    const leaf = path[path.length - 1]!;
    if (remove) {
      if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
      else delete parent[leaf];
    } else parent[leaf] = value;
    return copy;
  }
  setPath(root: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> { return this.change(root, path, value, false); }
  deletePath(root: Record<string, unknown>, path: readonly string[]): Record<string, unknown> { return this.change(root, path, undefined, true); }
}

type ScopeSnapshot = { status: string; value: unknown; base: unknown; user: unknown; revision?: number | undefined; writable: boolean; mode: "host" };
export class RemoteSettingsScope {
  private snapshot: ScopeSnapshot = { status: "loading", value: undefined, base: undefined, user: undefined, writable: false, mode: "host" };
  private listeners = new Set<() => void>();
  private tail = Promise.resolve();
  private disposed = false;
  private readonly unsubscribe: () => void;
  constructor(private mirror: RemoteSettingsMirror, private spec: { namespace: string; decode?: (value: unknown) => unknown }, private schema: RemoteSettingsSchema) {
    this.unsubscribe = mirror.subscribe(() => this.derive());
    this.derive();
  }
  getSnapshot = (): ScopeSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private derive(): void {
    const document = this.mirror.getSnapshot().view;
    if (!document || this.disposed) return;
    const view = document.namespaces.find((entry) => entry.ns === this.spec.namespace);
    let value: unknown;
    if (view) {
      try { value = this.spec.decode ? this.spec.decode(view.value) : this.schema.validate(this.schema.rehydrate(view.schema), view.value) === undefined ? view.value : undefined; } catch { value = undefined; }
    }
    this.snapshot = { status: view && value !== undefined ? "ready" : "unavailable", value, base: view?.base, user: view?.user, revision: view?.revision, writable: document.writable, mode: "host" };
    for (const listener of this.listeners) listener();
  }
  mutate(ops: readonly Op[], expectedRevision?: number): Promise<void> {
    const owned = structuredClone(ops);
    const task = this.tail.then(async () => {
      if (this.disposed || !this.snapshot.writable) return;
      try {
        const result = await this.mirror.remote.mutate(this.spec.namespace, owned, expectedRevision ?? this.snapshot.revision);
        if (!result.ok) { await this.mirror.load(); return; }
        if (!this.disposed) this.mirror.acceptView(result.value);
      } catch { await this.mirror.load(); }
    });
    this.tail = task.catch(() => {});
    return task;
  }
  set(field: string, value: unknown): Promise<void> { return this.mutate([{ op: "set", path: [field], value }]); }
  unset(field: string): Promise<void> { return this.mutate([{ op: "unset", path: [field] }]); }
  async dispose(): Promise<void> { this.disposed = true; this.unsubscribe(); this.listeners.clear(); await this.tail; }
}

type ProviderContext = {
  remote: { settings: SettingsRemote; $on(event: string, callback: () => void): () => void };
  on(event: string, callback: () => void): () => void;
  effect(callback: () => (() => void | Promise<void>), label?: string): void;
};
type ServiceConstructor = new (ctx: ProviderContext, name: string) => { ctx: ProviderContext };
/** Provider 的生命周期由 Cordis 托管；不改写官方实例。 */
export function installRemoteSettings(ctx: ProviderContext, Service: ServiceConstructor): void {
  const schema = new RemoteSettingsSchema();
  const mirror = new RemoteSettingsMirror(ctx.remote.settings);
  class SchemaProvider extends Service {
    rehydrate = schema.rehydrate.bind(schema);
    validate = schema.validate.bind(schema);
    nodeAtPath = schema.nodeAtPath.bind(schema);
    getPath = schema.getPath.bind(schema);
    hasPath = schema.hasPath.bind(schema);
    setPath = schema.setPath.bind(schema);
    deletePath = schema.deletePath.bind(schema);
  }
  class ScopeProvider extends Service {
    describe(): RemoteSettingsMirror { return mirror; }
    bind(spec: { namespace: string; decode?: (value: unknown) => unknown }): RemoteSettingsScope {
      const scope = new RemoteSettingsScope(mirror, spec, schema);
      this.ctx.effect(() => { void mirror.ensure(); return () => scope.dispose(); }, "remote settings scope");
      return scope;
    }
  }
  new SchemaProvider(ctx, "settingsSchema");
  new ScopeProvider(ctx, "settingsScope");
  ctx.effect(() => {
    const refresh = (): void => { void mirror.load(); };
    const disposers = [ctx.remote.$on("settings/document-updated", refresh), ctx.on("connection/reset", refresh)];
    return () => { mirror.dispose(); disposers.forEach((dispose) => dispose()); };
  }, "remote settings invalidation");
}
