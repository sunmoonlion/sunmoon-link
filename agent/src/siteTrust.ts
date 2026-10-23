// Installed packages carry site/site.json. Source checkouts and unit tests do not.
import fs from "node:fs";
import path from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface InstalledSite {
  root: string;
  mode: "bundled-ca" | "system";
  caPath: string | null;
}

export interface NodeLaunch {
  execArgv: string[];
  extraCa: string | null;
}

function derSha256(pem: string): string {
  if (pem.includes("PRIVATE KEY")) throw new Error("Site CA must be a certificate, not a private key");
  return createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
}

export function installedSite(moduleUrl: string): InstalledSite | null {
  const file = fileURLToPath(moduleUrl);
  const dist = path.dirname(file);
  const app = path.dirname(dist);
  if (path.basename(dist) !== "dist" || path.basename(app) !== "app") return null;
  const root = path.dirname(app);
  const siteFile = path.join(root, "site", "site.json");
  if (!fs.existsSync(siteFile)) return null;
  const site = JSON.parse(fs.readFileSync(siteFile, "utf8"));
  const trust = site?.trust;
  if (trust?.mode === "system" && !trust.ca_file && !trust.ca_sha256) return { root, mode: "system", caPath: null };
  if (trust?.mode !== "bundled-ca" || trust.ca_file !== "site/ca.pem" || !/^[a-f0-9]{64}$/.test(trust.ca_sha256)) {
    throw new Error("SITE_CA: 站点文件不完整。请重新从网页下载安装包。");
  }
  const caPath = path.join(root, "site", "ca.pem");
  const actual = derSha256(fs.readFileSync(caPath, "utf8"));
  if (actual !== trust.ca_sha256) throw new Error("SITE_CA: 站点证书与安装包记录不一致。请重新从网页下载安装包。");
  return { root, mode: "bundled-ca", caPath };
}

export function nodeLaunch(site: InstalledSite | null): NodeLaunch {
  if (!site) return { execArgv: [], extraCa: null };
  return { execArgv: ["--use-system-ca"], extraCa: site.caPath };
}

export function applyLaunchEnv(base: NodeJS.ProcessEnv, launch: NodeLaunch): NodeJS.ProcessEnv {
  const env = { ...base };
  if (!launch.execArgv.length && !launch.extraCa) return env;
  delete env.NODE_OPTIONS;
  delete env.NODE_EXTRA_CA_CERTS;
  if (launch.extraCa) env.NODE_EXTRA_CA_CERTS = launch.extraCa;
  return env;
}

export function relayHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    return /^[A-Za-z0-9.-]{1,253}$/.test(host) ? host : "会合点";
  } catch { return "会合点"; }
}

function sameCaFile(envPath: string | undefined, caPath: string): boolean {
  if (!envPath) return false;
  try {
    let left = fs.realpathSync.native(envPath);
    let right = fs.realpathSync.native(caPath);
    if (process.platform === "win32") { left = left.toLowerCase(); right = right.toLowerCase(); }
    return left === right;
  } catch { return false; }
}

export function installedLaunchError(moduleUrl: string): string | null {
  let site: InstalledSite | null;
  try { site = installedSite(moduleUrl); }
  catch (error) { return error instanceof Error ? error.message : "SITE_CA: 站点文件无法读取。请重新从网页下载安装包。"; }
  if (!site) return null;
  if (!process.execArgv.includes("--use-system-ca")) return "SITE_LAUNCH: 本地 link 没有按安装包的方式启动。请从安装目录的入口重新打开。";
  if (site.mode === "bundled-ca" && !sameCaFile(process.env.NODE_EXTRA_CA_CERTS, site.caPath ?? "")) {
    return "SITE_LAUNCH: 本地 link 没有使用安装包里的站点证书。请从安装目录的入口重新打开。";
  }
  if (site.mode === "system" && process.env.NODE_EXTRA_CA_CERTS) {
    return "SITE_LAUNCH: 正式站点不应额外指定证书。请从安装目录的入口重新打开。";
  }
  return null;
}
