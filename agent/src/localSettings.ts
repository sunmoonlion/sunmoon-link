import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, type AgentConfig } from "./config.js";
import { canonicalPath } from "./pathuri.js";
import { preferenceView, validatePreferences } from "./preferences.js";
import { LocalError } from "./localFiles.js";

export interface LocalSettingsOptions {
  file: string;
  config: () => AgentConfig;
  confirm: (description: string, signal: AbortSignal) => Promise<boolean>;
  autostart: { get: () => Promise<boolean>; set: (enabled: boolean) => Promise<void> };
  restart: () => Promise<void>;
  onChange?: () => void;
}
const denied = () => new LocalError(409, "local_denied");
const plainObject = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);

export class LocalSettings {
  private writing = false;
  private restarting = false;
  constructor(private readonly opts: LocalSettingsOptions) {}
  async read(version: string) {
    this.checkFile();
    return { ...preferenceView(loadConfig(this.opts.file)), autostart: await this.opts.autostart.get(), version };
  }
  /** Only config.json is written. The OS login task uses the existing local lifecycle. */
  async write(input: unknown, signal: AbortSignal): Promise<{ applied: true; restart: true }> {
    if (this.writing || this.restarting) throw new LocalError(409, "busy");
    this.writing = true;
    let restoreAutostart: boolean | undefined;
    try {
      let cfg: AgentConfig, next: AgentConfig, snapshot: Buffer;
      const value: any = input;
      try {
        if (!plainObject(value) || !Object.keys(value).length || Object.keys(value).some(key => !["roots", "rootChoices", "ceiling", "autostart"].includes(key))) throw new Error();
        if ("autostart" in value && typeof value.autostart !== "boolean") throw new Error();
        this.checkFile(); snapshot = fs.readFileSync(this.opts.file); cfg = loadConfig(this.opts.file);
        next = { ...cfg, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "autostart")) };
        validatePreferences(next, path.dirname(this.opts.file));
      } catch { throw new LocalError(400, "invalid"); }
      const enabled = await this.opts.autostart.get();
      const widening: string[] = [];
      for (const root of next.roots) if (!cfg.roots.some(old => canonicalPath(old) === canonicalPath(root))) widening.push(`加目录 ${root}`);
      if (cfg.ceiling.sandbox === "read-only" && next.ceiling.sandbox === "workspace-write") widening.push("允许写工作目录");
      if (!cfg.ceiling.network && next.ceiling.network) widening.push("允许联网");
      if (value.autostart === true && !enabled) widening.push("开启登录自启");
      if (signal.aborted) throw denied();
      if (widening.length) {
        const deadline = new AbortController(), abort = () => deadline.abort();
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 60000);
        try {
          // Race as well as signal: a broken UI callback cannot leave this write stuck.
          const cancelled = new Promise<boolean>(resolve => deadline.signal.addEventListener("abort", () => resolve(false), { once: true }));
          const approved = await Promise.race([Promise.resolve().then(() => this.opts.confirm(`网页要把这台电脑的设置改成：${widening.join("；")}。\n只有你自己刚在网页上点了保存才输入下面的码。`, deadline.signal)).catch(() => false), cancelled]);
          if (!approved || deadline.signal.aborted || signal.aborted) throw denied();
        } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); deadline.abort(); }
      }
      // The directory or local configuration may have changed during the dialog.
      this.unchanged(snapshot!);
      try { validatePreferences(next!, path.dirname(this.opts.file)); } catch { throw new LocalError(400, "invalid"); }
      if (signal.aborted) throw denied();
      if ("autostart" in value && value.autostart !== enabled) {
        restoreAutostart = enabled;
        await this.opts.autostart.set(value.autostart);
      }
      if (signal.aborted) throw denied();
      this.unchanged(snapshot!);
      next!.lastSettingsChange = new Date().toISOString();
      this.save(next!);
      restoreAutostart = undefined;
      Object.assign(this.opts.config(), next!);
      this.restarting = true; // Serialize writes until restart is handed to the local lifecycle.
      this.opts.onChange?.();
      return { applied: true, restart: true };
    } catch (cause) {
      if (restoreAutostart !== undefined) await this.opts.autostart.set(restoreAutostart);
      throw cause;
    } finally { this.writing = false; }
  }
  async restart(): Promise<void> {
    try { await this.opts.restart(); } finally { this.restarting = false; }
  }
  private checkFile(): void {
    const st = fs.lstatSync(this.opts.file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 65536) throw new Error("Unsafe config file");
  }
  private unchanged(snapshot: Buffer): void {
    this.checkFile();
    if (!snapshot.equals(fs.readFileSync(this.opts.file))) throw new LocalError(409, "busy");
  }
  private save(cfg: AgentConfig): void {
    const temporary = path.join(path.dirname(this.opts.file), `.settings-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(cfg, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.opts.file);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
}
