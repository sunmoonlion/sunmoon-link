import fs from "node:fs";
import path from "node:path";
import { type AgentConfig, validate } from "./config.js";
import { canonicalPath, isUnder } from "./pathuri.js";
import { assertWindowsHome } from "./windowsRuntime.js";

/** Both tray and loopback settings use this validation before any side effect. */
export function validatePreferences(cfg: AgentConfig, configDir: string): void {
  try { checkPreferences(cfg, configDir); } catch { throw new Error("Invalid local preferences"); }
}
function checkPreferences(cfg: AgentConfig, configDir: string): void {
  const choices = cfg.rootChoices ?? cfg.roots;
  if (!["read-only", "workspace-write"].includes(cfg.ceiling?.sandbox)
    || Object.keys(cfg.ceiling).sort().join(",") !== "network,sandbox") throw new Error("Invalid ceiling");
  for (const dirs of [cfg.roots, choices]) {
    if (!Array.isArray(dirs) || dirs.length > 32 || dirs.some(root => typeof root !== "string" || canonicalPath(root) === null || !fs.statSync(root).isDirectory())
      || new Set(dirs.map(root => canonicalPath(root))).size !== dirs.length) throw new Error("Invalid directory choices");
  }
  if (cfg.roots.some(root => !choices.some(choice => canonicalPath(choice) === canonicalPath(root)))) throw new Error("Invalid directory selection");
  validate(cfg);
  const reads = choices;
  if (process.platform === "win32") {
    assertWindowsHome(configDir, reads); assertWindowsHome(cfg.codexHome, reads);
  } else {
    for (const root of reads) {
      if ([configDir, cfg.codexHome].some(home => isUnder(home, root) || isUnder(root, home))) throw new Error("Protected directory");
      let current = path.resolve(root);
      for (;;) {
        if (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync.native(current) !== current) throw new Error("Directory alias refused");
        const parent = path.dirname(current); if (parent === current) break; current = parent;
      }
    }
  }
}

export function preferenceView(cfg: AgentConfig) {
  return { machineName: cfg.machineName, roots: cfg.roots, rootChoices: cfg.rootChoices ?? cfg.roots, ceiling: cfg.ceiling, lastSettingsChange: cfg.lastSettingsChange ?? null };
}
