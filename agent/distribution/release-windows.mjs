// One command for the Windows package (ledger 128). Release cards and the manual use only this:
//   node agent/distribution/release-windows.mjs --node-exe <official node.exe> --site <profile.json> --out <directory> [--ca-pem <pem>]
// 1. checkout: export the committed agent/ of HEAD into a fresh directory (git archive); never reuse an old dependency directory
//    (0028 R5.3: a copied one lost pnpm's links and @openai/codex-win32-x64 could not be resolved);
// 2. frozen install of the Windows dependencies in that checkout (pnpm --frozen-lockfile --ignore-scripts --prod --os win32 --cpu x64);
// 3. check the pnpm layout: @openai/codex and its win32-x64 platform package are both there, or stop;
// 4. assemble with build.mjs (its own source, version, lock, digest and manifest checks);
// 5. encoding probe: a .ps1 with non-ASCII text starts with a UTF-8 BOM, .cmd/.vbs are ASCII, every .ps1 parses in Windows PowerShell;
// 6. self-check on Windows: windows-candidate.mjs with the bundled node.exe (first install into a synthetic LocalAppData);
// 7. deterministic ZIP (zip.mjs); digests printed and written to <name>.receipt.json next to it.
// Runs on WSL (Windows programs through interop) or on Windows. Stops at the first failure and keeps the work directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { MANIFEST, digest, exists, inventory } from './bundle.mjs';
import { writeZip } from './zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const agent = path.dirname(here), repo = path.dirname(agent);
const settings = JSON.parse(fs.readFileSync(path.join(here, 'windows-x64.json'), 'utf8'));
const windows = process.platform === 'win32';
const wsl = process.platform === 'linux' && (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || /microsoft/i.test(os.release()));

function run(command, args, { cwd = repo, timeout = 600000, input } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, shell: false, maxBuffer: 64 * 1024 * 1024,
    input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error?.code ?? result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout.trim();
}
const winPath = file => windows ? file : run('wslpath', ['-w', file]);
const powershell = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

function checkLayout(checkout) {
  const codex = path.join(checkout, 'node_modules', '@openai', 'codex', 'package.json');
  if (!exists(codex)) throw new Error('Frozen install has no @openai/codex');
  const platform = settings.packages.find(p => p.resolveFrom === '@openai/codex');
  try { createRequire(fs.realpathSync(codex)).resolve(`${platform.installName}/package.json`); }
  catch { throw new Error(`Frozen install has no ${platform.installName}; the Windows package needs it`); }
  return platform.installName;
}

function probeEncoding(bundle) {
  const counts = { ps1: 0, ascii: 0, parsed: 0 };
  for (const file of inventory(bundle)) {
    const ext = path.extname(file.path).toLowerCase();
    if (!['.ps1', '.cmd', '.vbs'].includes(ext)) continue;
    const bytes = fs.readFileSync(path.join(bundle, file.path));
    const ascii = !bytes.some(b => b > 0x7f);
    if (ext === '.ps1') {
      counts.ps1++;
      // Windows PowerShell 5.1 reads a file without BOM in the ANSI code page: Chinese text turns into garbage.
      if (!ascii && !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw new Error(`Encoding probe: ${file.path} has non-ASCII text but no UTF-8 BOM`);
      const script = winPath(path.join(bundle, file.path)).replaceAll("'", "''");
      const errors = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$t,[ref]$e);$e.Count`], { timeout: 120000 });
      if (errors !== '0') throw new Error(`Encoding probe: ${file.path} does not parse in Windows PowerShell (${errors} errors)`);
      counts.parsed++;
    } else {
      // cmd.exe and wscript read these in the ANSI code page.
      if (!ascii) throw new Error(`Encoding probe: ${file.path} must be ASCII`);
      counts.ascii++;
    }
  }
  return counts;
}

function selfCheck(bundle, manifestSha256) {
  const script = path.join(here, 'test', 'windows-candidate.mjs');
  if (windows) return JSON.parse(run(path.join(bundle, 'node', 'node.exe'), [script, bundle, manifestSha256], { cwd: path.dirname(bundle), timeout: 300000 }));
  // On WSL, cmd.exe cannot run from a \\wsl.localhost path: check a copy in the Windows temp directory, then remove that copy.
  const temp = run('wslpath', ['-u', run('/mnt/c/Windows/System32/cmd.exe', ['/d', '/c', 'echo %TEMP%'], { cwd: '/mnt/c' })]);
  const place = fs.mkdtempSync(path.join(temp, 'sunmoon-candidate-'));
  const copy = path.join(place, path.basename(bundle));
  fs.cpSync(bundle, copy, { recursive: true, errorOnExist: true });
  fs.mkdirSync(path.join(place, 'distribution', 'test'), { recursive: true });
  // windows-candidate.mjs imports ../bundle.mjs, which imports its siblings (launch.mjs …): copy them all
  for (const name of fs.readdirSync(here)) if (/\.(mjs|json)$/.test(name)) fs.copyFileSync(path.join(here, name), path.join(place, 'distribution', name));
  fs.copyFileSync(script, path.join(place, 'distribution', 'test', 'windows-candidate.mjs'));
  const result = JSON.parse(run(path.join(copy, 'node', 'node.exe'), [winPath(path.join(place, 'distribution', 'test', 'windows-candidate.mjs')), winPath(copy), manifestSha256],
    { cwd: place, timeout: 300000 }));
  fs.rmSync(place, { recursive: true }); // our own copy; kept when the check fails
  return result;
}

try {
  const startedAt = new Date().toISOString();
  const { values } = parseArgs({ options: {
    'node-exe': { type: 'string' }, site: { type: 'string' }, out: { type: 'string' }, 'ca-pem': { type: 'string' },
  }, allowPositionals: false, strict: true });
  if (!values['node-exe'] || !values.site || !values.out) {
    throw new Error('Usage: node agent/distribution/release-windows.mjs --node-exe <official node.exe> --site <profile.json> --out <directory> [--ca-pem <certificate>]');
  }
  if (!windows && !wsl) throw new Error('Run on Windows or WSL: the self-check runs the bundled node.exe on Windows');
  const tracked = ['agent/src', 'agent/native', 'agent/package.json', 'agent/tsconfig.json', 'agent/pnpm-lock.yaml', 'agent/distribution'];
  if (run('git', ['status', '--porcelain', '--untracked-files=all', '--', ...tracked])) throw new Error('Commit source and distribution changes before releasing');
  const revision = run('git', ['rev-parse', 'HEAD']);
  const name = `sunmoon-link-${settings.agentVersion}-${revision.slice(0, 7)}-windows-x64`;
  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  const bundle = path.join(out, name), zip = `${bundle}.zip`, receipt = `${bundle}.receipt.json`;
  if ([bundle, zip, receipt].some(exists)) throw new Error(`Output already exists in ${out}; choose a new directory`);
  const work = fs.mkdtempSync(path.join(out, `.work-${revision.slice(0, 7)}-`));
  console.log(`Work directory: ${work}`);

  // 1–3
  const tar = path.join(work, 'source.tar');
  const archived = spawnSync('git', ['archive', '--format=tar', revision, 'agent'], { cwd: repo, maxBuffer: 1024 ** 3 });
  if (archived.error || archived.status !== 0) throw new Error(`git archive failed: ${archived.error?.code ?? archived.status}`);
  fs.writeFileSync(tar, archived.stdout, { flag: 'wx' });
  const source = path.join(work, 'source'); fs.mkdirSync(source);
  run('tar', ['-xf', tar, '-C', source], { cwd: work });
  const checkout = path.join(source, 'agent');
  const pnpm = windows ? 'pnpm.cmd' : 'pnpm';
  const pnpmVersion = run(pnpm, ['--version'], { cwd: checkout });
  run(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts', '--prod', '--os', 'win32', '--cpu', 'x64'], { cwd: checkout, timeout: 1800000 });
  const platformPackage = checkLayout(checkout);

  // 4
  const built = run(process.execPath, [path.join(here, 'build.mjs'), '--node-exe', path.resolve(values['node-exe']), '--dependencies', checkout,
    '--site', path.resolve(values.site), '--output', bundle, ...(values['ca-pem'] ? ['--ca-pem', path.resolve(values['ca-pem'])] : [])]);
  const assembly = JSON.parse(built.slice(built.indexOf('{')));
  if (assembly.sourceRevision !== revision) throw new Error('Assembled revision differs from HEAD');

  // 5–6
  const encoding = probeEncoding(bundle);
  const candidate = selfCheck(bundle, assembly.manifestSha256);
  if (candidate.result !== 'pass' || candidate.manifestSha256 !== assembly.manifestSha256) throw new Error('Self-check did not pass');

  // 7
  const { entries } = writeZip(bundle, zip);
  const archive = digest(zip);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, MANIFEST), 'utf8'));
  const result = {
    name, sourceRevision: revision, agentVersion: manifest.agentVersion, codexVersion: manifest.codexVersion, nodeVersion: manifest.nodeVersion,
    site: path.basename(values.site), zip, zipSha256: archive.sha256, zipBytes: archive.size, zipEntries: entries,
    manifestSha256: assembly.manifestSha256, files: assembly.files,
    checks: { frozenInstall: 'pnpm --frozen-lockfile --ignore-scripts --prod --os win32 --cpu x64', platformPackage, encoding, candidate: candidate.result },
    builder: { platform: windows ? 'windows' : 'wsl', node: process.version, zlib: process.versions.zlib, pnpm: pnpmVersion },
    startedAt, finishedAt: new Date().toISOString(),
    status: 'candidate; not uploaded, no agent started on this computer',
  };
  fs.writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  fs.rmSync(work, { recursive: true }); // our own mkdtemp directory: the checkout and its frozen install
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`Release stopped: ${error.message}`); process.exitCode = 1; }
