// Shared by the builder and first-install entry. No network, process launch or user config reads.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readInstalledSite } from './launch.mjs';

export const MANIFEST = 'bundle-manifest.json';
const HEX = /^[a-f0-9]{64}$/;
const isHash = value => typeof value === 'string' && HEX.test(value);
const REQUIRED = [
  'node/node.exe', 'licenses/node-LICENSE', 'licenses/codex-LICENSE', 'licenses/codex-NOTICE',
  'app/package.json', 'app/dist/cli.js', 'app/native/helper.mjs',
  'app/dist/resident.js', 'app/dist/windowsDesktop.js', 'app/native/desktop.ps1', 'app/native/run-hidden.vbs', 'app/native/open-desktop.vbs',
  'app/node_modules/@openai/codex/package.json',
  'app/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  'app/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-resources/codex-command-runner.exe',
  'app/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex-resources/codex-windows-sandbox-setup.exe',
  'app/node_modules/smol-toml/package.json', 'app/node_modules/ws/package.json',
  'sunmoon-link.cmd', 'install.cmd', 'installer/install.mjs', 'installer/bundle.mjs',
  'uninstall.cmd', 'installer/uninstall.mjs', 'installer/launch.mjs', 'installer/upgrade.mjs',
  'app/native/elevated-setup.ps1',
];
// Linux 包（分身测试的测试电脑用，SDD 0027 §3.4）：不带 Node（用镜像里的），没有 Windows 界面与安装器
const REQUIRED_LINUX = [
  'licenses/codex-LICENSE', 'licenses/codex-NOTICE',
  'app/package.json', 'app/dist/cli.js',
  'app/node_modules/@openai/codex/package.json',
  'app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
  'app/node_modules/smol-toml/package.json', 'app/node_modules/ws/package.json',
  'installer/bundle.mjs', 'installer/launch.mjs',
];
const LAYOUTS = { win32: REQUIRED, linux: REQUIRED_LINUX };

export function relativeFile(name) {
  if (typeof name !== 'string' || name.length > 240 || name.includes('\\') ||
      !name.split('/').every(part => /^[A-Za-z0-9_@.-]+$/.test(part) && part !== '.' && part !== '..' &&
        !part.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Unsafe bundle path');
  }
  return name;
}

export function exists(file) {
  try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

// Refuse links/junctions, including ancestors. This is an ordinary-user installer,
// not a security boundary against another process running as that same user.
export function plainDirectory(directory) {
  let absolute = path.resolve(directory);
  if (process.platform === 'win32') {
    try {
      if (fs.existsSync(absolute)) {
        absolute = fs.realpathSync.native(absolute);
      } else {
        const parent = path.dirname(absolute);
        if (fs.existsSync(parent)) {
          absolute = path.join(fs.realpathSync.native(parent), path.basename(absolute));
        }
      }
    } catch {}
    if (!/^[A-Za-z]:\\/.test(absolute) || absolute.slice(3).includes(':') || /~[0-9]/.test(absolute)) {
      throw new Error('Install/build paths must be ordinary local drive paths');
    }
  }
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Directory link or non-directory refused');
  }
  return absolute;
}

export function digest(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 ** 3) throw new Error('Not a supported regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== st.ino || opened.dev !== st.dev || !opened.isFile()) throw new Error('File changed during open');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0, n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { size += n; hash.update(buffer.subarray(0, n)); }
    const after = fs.fstatSync(fd);
    if (size !== st.size || after.mtimeMs !== opened.mtimeMs || after.size !== opened.size) throw new Error('File changed while hashing');
    return { size, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}

export function inventory(directory) {
  plainDirectory(directory);
  const files = [], seen = new Set();
  function walk(prefix) {
    const names = fs.readdirSync(path.join(directory, prefix)).sort();
    for (const name of names) {
      const rel = relativeFile(prefix ? `${prefix}/${name}` : name);
      const key = rel.toLowerCase();
      if (seen.has(key)) throw new Error('Case-insensitive path collision');
      seen.add(key);
      const full = path.join(directory, rel), st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new Error('Bundle links are forbidden');
      if (st.isDirectory()) walk(rel);
      else if (st.isFile()) files.push({ path: rel, ...digest(full) });
      else throw new Error('Bundle contains a special file');
      if (seen.size > 10000) throw new Error('Bundle has too many entries');
    }
  }
  walk('');
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error('Unexpected manifest fields');
}

export function validateManifest(manifest, options = {}) {
  shape(manifest, ['schema', 'platform', 'architecture', 'agentVersion', 'codexVersion', 'nodeVersion',
    'relayProtocol', 'sourceRevision', 'dependencyLockSha256', 'files']);
  // 默认只认 Windows 包（安装器、升级、卸载都走这里）；Linux 包要调用方明说 platform: 'linux'
  const platform = options.platform ?? 'win32';
  if (manifest.schema !== 1 || manifest.platform !== platform || !Object.hasOwn(LAYOUTS, platform) || manifest.architecture !== 'x64' ||
      manifest.relayProtocol !== 1 || typeof manifest.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision) ||
      !isHash(manifest.dependencyLockSha256) ||
      !['agentVersion', 'codexVersion', 'nodeVersion'].every(k => typeof manifest[k] === 'string' && /^\d+\.\d+\.\d+$/.test(manifest[k])) ||
      !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new Error('Unsupported manifest');
  const seen = new Set();
  let total = 0;
  for (const file of manifest.files) {
    shape(file, ['path', 'size', 'sha256']);
    const key = relativeFile(file.path).toLowerCase();
    if (seen.has(key) || key === MANIFEST || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !isHash(file.sha256)) throw new Error('Invalid manifest file');
    seen.add(key); total += file.size;
  }
  if (total > 2 * 1024 ** 3) throw new Error('Incomplete or oversized bundle');
  // The current file list is for packing and first install of a new package.
  // An already-installed directory is checked against its own manifest.
  if (options.requireLayout !== false && !LAYOUTS[manifest.platform].every(name => seen.has(name.toLowerCase()))) throw new Error('Incomplete or oversized bundle');
  return manifest;
}

export function verifyBundle(directory, expectedManifestHash, options = {}) {
  if (!isHash(expectedManifestHash)) throw new Error('Expected manifest SHA256 is required');
  plainDirectory(directory);
  const manifestFile = path.join(directory, MANIFEST);
  const stat = digest(manifestFile);
  if (stat.size > 4 * 1024 * 1024 || stat.sha256 !== expectedManifestHash) throw new Error('Manifest digest mismatch');
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')), options);
  const actual = inventory(directory).filter(item => item.path !== MANIFEST);
  const expected = [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (actual.length !== expected.length || actual.some((f, i) => f.path !== expected[i].path ||
      f.size !== expected[i].size || f.sha256 !== expected[i].sha256)) throw new Error('Bundle content mismatch');
  if (actual.some(file => file.path === 'site/site.json')) readInstalledSite(directory);
  return manifest;
}

export function copyFile(source, destination) {
  const before = digest(source);
  plainDirectory(path.dirname(destination));
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const after = digest(destination);
  if (before.size !== after.size || before.sha256 !== after.sha256) throw new Error('Copy verification failed');
}

// Only creates descendants of an already checked root; no recursive mkdir through junctions.
export function makeSubdirectory(root, relative) {
  plainDirectory(root);
  let current = root;
  if (!relative || relative === '.') return;
  for (const part of relativeFile(relative).split('/')) {
    current = path.join(current, part);
    if (!exists(current)) fs.mkdirSync(current);
    plainDirectory(current);
  }
}

export function firstInstall({ source, localAppData, expectedManifestHash, apply = false }) {
  const bundle = plainDirectory(source), base = plainDirectory(localAppData);
  const destination = path.join(base, 'Programs', 'sunmoon-link');
  const relative = path.relative(bundle, destination);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Source and install destination overlap');
  }
  if (exists(destination)) throw new Error('An installation already exists; in-place replacement is not supported yet');
  if (exists(path.dirname(destination))) plainDirectory(path.dirname(destination));
  const manifest = verifyBundle(bundle, expectedManifestHash);
  const plan = { action: apply ? 'installed' : 'preview', destination,
    files: manifest.files.length + 1, bytes: manifest.files.reduce((n, f) => n + f.size, 0),
    startsAgent: false, registersLogonTask: false, changesUserConfig: false, needsAdministrator: false };
  if (!apply) return plan;
  const free = fs.statfsSync(base, { bigint: true });
  if (free.bavail * free.bsize < BigInt(plan.bytes) + 64n * 1024n * 1024n) throw new Error('Insufficient installation space');
  makeSubdirectory(base, 'Programs');
  // Exclusive destination ownership; never overwrite or recursively delete an existing directory.
  // On interruption, the partial directory remains for explicit inspection/removal.
  fs.mkdirSync(destination);
  const marker = path.join(destination, '.install-incomplete');
  fs.writeFileSync(marker, randomUUID(), { flag: 'wx' });
  const files = [...manifest.files].sort((a, b) => Number(a.path.endsWith('.cmd')) - Number(b.path.endsWith('.cmd')));
  for (const file of files) {
    makeSubdirectory(destination, path.posix.dirname(file.path));
    copyFile(path.join(bundle, file.path), path.join(destination, file.path));
  }
  copyFile(path.join(bundle, MANIFEST), path.join(destination, MANIFEST));
  fs.unlinkSync(marker);
  try { verifyBundle(destination, expectedManifestHash); }
  catch (error) { fs.writeFileSync(marker, 'verification failed', { flag: 'wx' }); throw error; }
  return plan;
}

// No recursive rm. Unknown, modified or linked files fail before any removal.
export function retryRemoval(file, remove = fs.unlinkSync, wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)) {
  for (let retry = 0; ; retry++) {
    try { plainDirectory(path.dirname(file)); remove(file); return; }
    catch (error) {
      if (!['EPERM','EBUSY'].includes(error.code) || retry >= 10) {
        throw new Error(`Cannot remove ${file}: ${error.code ?? error.message}`, {cause:error});
      }
      wait(500);
    }
  }
}
export function removeVerifiedBundle(directory, expectedManifestHash, apply = false) {
  const manifest = verifyBundle(directory, expectedManifestHash, { requireLayout: false });
  const plan = { directory, files: manifest.files.length + 1, apply };
  if (!apply) return plan;
  const marker = path.join(directory, '.uninstall-incomplete');
  // Written only after complete verification, before the first deletion. Any
  // interruption now has an explicit recovery signal, even if manifest is gone.
  fs.writeFileSync(marker, randomUUID(), {flag:'wx',mode:0o600});
  try {
  for (const entry of [...manifest.files, {path: MANIFEST}]) {
    plainDirectory(path.dirname(path.join(directory, entry.path)));
    retryRemoval(path.join(directory, entry.path));
  }
  function empty(dir) {
    plainDirectory(dir);
    for (const name of fs.readdirSync(dir)) {
      const full=path.join(dir,name);
      if (full === marker) continue;
      if (!fs.lstatSync(full).isDirectory()) throw new Error('Unexpected file appeared during removal');
      empty(full);
    }
    if (dir === directory) retryRemoval(marker);
    retryRemoval(dir,fs.rmdirSync);
  }
  empty(directory); return plan;
  } catch (error) {
    if (exists(directory) && !exists(marker)) { plainDirectory(directory); fs.writeFileSync(marker,'removal incomplete',{flag:'wx',mode:0o600}); }
    throw error;
  }
}
