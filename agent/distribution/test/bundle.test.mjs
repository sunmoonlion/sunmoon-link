import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MANIFEST, relativeFile, digest, inventory, firstInstall, verifyBundle, validateManifest, removeVerifiedBundle, retryRemoval } from '../bundle.mjs';
import { decideUpgrade, inspectInstalled, installedDecision } from '../upgrade.mjs';
import { clearStaleTray } from '../uninstall.mjs';
import { certificateDerSha256, siteDocument, writeSite } from '../launch.mjs';

const samplePaths = [
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

test('UI watchdog covers settings and tray with a one-second lifetime check', () => {
  const text = fs.readFileSync(new URL('../../native/desktop.ps1', import.meta.url), 'utf8');
  assert.match(text, /\$Watch\.Interval=1000/);
  assert.match(text, /\$Window\.IsDisposed -or -not \$Window\.IsHandleCreated/);
  for (const form of ['Dialog', 'Form', 'TrayForm']) assert.ok(text.includes(`New-FormWatchdog $${form}`));
  assert.match(text, /finally\s*\{[\s\S]*foreach \(\$Name in @\('tray.json'\)\)/);
  assert.ok(text.includes('if ($Record.pid -eq $PID)'));
});
test('confirm explicitly shows the first form and exits on visibility failure or disposal',()=>{
  const text=fs.readFileSync(new URL('../../native/desktop.ps1',import.meta.url),'utf8');
  const confirm=text.slice(text.indexOf("if ($Action -eq 'confirm')"),text.indexOf('# The tray'));
  assert.ok(confirm.includes('Initialize-VisibleForm $Form'));
  assert.ok(confirm.includes('New-FormWatchdog $Form'));
  assert.match(text,/ShowWindow\(\$Sender.Handle,5\)/);
  assert.match(text,/IsWindowVisible\(\$Sender.Handle\)\) \{ \$Sender.Close\(\) \}/);
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sunmoon-dist-test-'));
  // Only this test's unique temporary directory is removed. No actual installation/user state.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'candidate'), localAppData = path.join(root, 'Local');
  fs.mkdirSync(source); fs.mkdirSync(localAppData);
  for (const file of samplePaths) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), `synthetic: ${file}\n`);
  }
  const manifest = { schema: 1, platform: 'win32', architecture: 'x64', agentVersion: '0.2.0', codexVersion: '0.155.1',
    nodeVersion: '24.19.0', relayProtocol: 1, sourceRevision: 'a'.repeat(40), dependencyLockSha256: 'b'.repeat(64), files: inventory(source) };
  const save = () => { fs.writeFileSync(path.join(source, MANIFEST), JSON.stringify(manifest)); return digest(path.join(source, MANIFEST)).sha256; };
  return { root, source, localAppData, manifest, expectedManifestHash: save(), save };
}

test('locked files retry ten times at 500ms and report the exact final path', () => {
  const file=path.join(os.tmpdir(),'sunmoon-synthetic-locked-file'); let calls=0; const waits=[];
  retryRemoval(file,()=>{calls++;if(calls<=10)throw Object.assign(new Error('busy'),{code:'EBUSY'});},ms=>waits.push(ms));
  assert.equal(calls,11);assert.deepEqual(waits,Array(10).fill(500));
  calls=0;waits.length=0;
  assert.throws(()=>retryRemoval(file,()=>{calls++;throw Object.assign(new Error('locked'),{code:'EPERM'});},ms=>waits.push(ms)),e=>e.message.includes(file)&&e.message.includes('EPERM'));
  assert.equal(calls,11);assert.equal(waits.length,10);
  assert.throws(()=>retryRemoval(file,()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});},()=>assert.fail('must not retry')),/EACCES/);
});

test('half uninstall marker and missing or changed manifest files choose repair preserving config', t => {
  const f=fixture(t),installed=firstInstall({...f,apply:true}).destination;
  const config=path.join(f.root,'config.json'); fs.writeFileSync(config,'synthetic-config-unchanged');
  fs.unlinkSync(path.join(installed,'app/dist/cli.js'));
  assert.equal(installedDecision(installed,'0.2.8').action,'repair');
  fs.writeFileSync(path.join(installed,'.uninstall-incomplete'),'synthetic');
  fs.unlinkSync(path.join(installed,MANIFEST));
  assert.equal(installedDecision(installed,'0.2.8').action,'repair');
  assert.equal(installedDecision(installed,'0.2.8').preserveConfig,true);
  assert.equal(fs.readFileSync(config,'utf8'),'synthetic-config-unchanged');
  assert.throws(()=>installedDecision(installed,'not-a-version'),/版本号/);
});
test('repair never accepts a linked installation or linked leftover file', t => {
  const f=fixture(t),installed=firstInstall({...f,apply:true}).destination;
  fs.writeFileSync(path.join(installed,'.uninstall-incomplete'),'synthetic');
  const outside=path.join(f.root,'outside');
  const target=process.platform==='win32'?path.join(outside,'keep.txt'):outside;
  if(process.platform==='win32')fs.mkdirSync(outside);
  fs.writeFileSync(target,'keep');
  fs.symlinkSync(outside,path.join(installed,'linked'),process.platform==='win32'?'junction':undefined);
  assert.throws(()=>installedDecision(installed,'0.2.8'),/links/);
  assert.equal(fs.readFileSync(target,'utf8'),'keep');
});
test('interrupted removal retains its recovery marker, successful removal leaves no directory', t => {
  const f=fixture(t),installed=firstInstall({...f,apply:true}).destination;
  const unlink=fs.unlinkSync;
  try {
    fs.unlinkSync=file=>{if(file.endsWith('cli.js'))throw Object.assign(new Error('synthetic denied'),{code:'EACCES'});return unlink(file);};
    assert.throws(()=>removeVerifiedBundle(installed,f.expectedManifestHash,true),/cli.js/);
  } finally {fs.unlinkSync=unlink;}
  assert.equal(fs.existsSync(path.join(installed,'.uninstall-incomplete')),true);
  assert.equal(installedDecision(installed,'0.2.8').action,'repair');
});
test('repair templates archive leftovers after external process collection and stay byte-identical', () => {
  const runtime=fs.readFileSync(new URL('../install.ps1.tmpl',import.meta.url));
  const k8s=fs.readFileSync(process.env.SUNMOON_TEST_INSTALL_TEMPLATE ?? new URL('../../../../k8s/gitops/components/app-platform/knowbench-app/knowbench-backend/agent-releases/install.ps1.tmpl',import.meta.url));
  assert.deepEqual(runtime,k8s);
  const text=runtime.toString('utf8');
  assert.ok(text.indexOf('--stop-only')<text.indexOf('[System.IO.Directory]::Move($Dest,$Broken)'));
  assert.ok(text.includes('上次升级没做完，已清理残留'));
});
test('installer preserves failure while giving an actionable old-window hint', () => {
  const text=fs.readFileSync(new URL('../install.ps1.tmpl',import.meta.url),'utf8');
  assert.match(text,/catch\s*\{\s*Write-Warning '可能有旧窗口的进程还开着，先在托盘退出、关掉所有 SunMoon 窗口再试'\s*throw\s*\}\s*finally/);
});

test('uninstall preview keeps all files; apply removes only exact verified program inventory', t => {
  const f=fixture(t); const installed=firstInstall({...f,apply:true});
  const before=inventory(installed.destination);
  removeVerifiedBundle(installed.destination,f.expectedManifestHash);
  assert.deepEqual(inventory(installed.destination),before);
  removeVerifiedBundle(installed.destination,f.expectedManifestHash,true);
  assert.equal(fs.existsSync(installed.destination),false);assert.equal(fs.existsSync(f.source),true);
});
test('uninstall refuses unknown file and modified byte without partial deletion',t=>{
  const f=fixture(t);const installed=firstInstall({...f,apply:true});
  const unknown=path.join(installed.destination,'user-data.txt');fs.writeFileSync(unknown,'keep');
  assert.throws(()=>removeVerifiedBundle(installed.destination,f.expectedManifestHash,true),/mismatch/);
  assert.equal(fs.readFileSync(unknown,'utf8'),'keep');
  fs.unlinkSync(unknown);fs.appendFileSync(path.join(installed.destination,'app/dist/cli.js'),'tamper');
  assert.throws(()=>removeVerifiedBundle(installed.destination,f.expectedManifestHash,true),/mismatch/);
  assert.equal(fs.existsSync(path.join(installed.destination,MANIFEST)),true);
});

test('complete inventory is deterministic and requires independent expected checksum', t => {
  const f = fixture(t);
  assert.deepEqual(verifyBundle(f.source, f.expectedManifestHash), f.manifest);
  assert.throws(() => verifyBundle(f.source), /required/);
  assert.throws(() => verifyBundle(f.source, '0'.repeat(64)), /digest mismatch/);
});
for (const bad of ['../outside', '/absolute', 'a/../outside', 'C:/outside', 'a\\b', 'file:stream',
  'dir/NUL.txt', 'dir/COM1', 'file.', 'dir//file', './file', 'file ', 'dir/..']) {
  test(`reject Windows/path alias: ${bad}`, () => assert.throws(() => relativeFile(bad), /Unsafe/));
}
test('tampered, missing and additional files all stop before creating a destination', t => {
  const f = fixture(t), file = path.join(f.source, 'app/dist/cli.js'), original = fs.readFileSync(file);
  fs.appendFileSync(file, 'tamper');
  assert.throws(() => firstInstall({ ...f, apply: true }), /content mismatch/);
  fs.unlinkSync(file);
  assert.throws(() => verifyBundle(f.source, f.expectedManifestHash), /content mismatch/);
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(f.source, 'auth.json'), 'synthetic extra');
  assert.throws(() => firstInstall({ ...f, apply: true }), /content mismatch/);
  assert.equal(fs.existsSync(path.join(f.localAppData, 'Programs')), false);
});
test('manifest rejects duplicate, case aliases, private extra fields and missing helper', t => {
  const f = fixture(t);
  for (const item of [{ ...f.manifest.files[0] }, { ...f.manifest.files[0], path: f.manifest.files[0].path.toUpperCase() }]) {
    assert.throws(() => validateManifest({ ...f.manifest, files: [...f.manifest.files, item] }), /Invalid/);
  }
  assert.throws(() => validateManifest({ ...f.manifest, token: 'synthetic' }), /Unexpected/);
  assert.throws(() => validateManifest({ ...f.manifest, nodeVersion: ['24.19.0'] }), /Unsupported/);
  assert.throws(() => validateManifest({ ...f.manifest, files: f.manifest.files.filter(f => f.path !== 'app/native/helper.mjs') }), /Incomplete/);
});
test('manifest rejects negative sizes, manifest-self entries and traversal', t => {
  const f = fixture(t);
  for (const patch of [{ size: -1 }, { path: MANIFEST }, { path: '../../outside' }, { sha256: ['a'.repeat(64)] }]) {
    assert.throws(() => validateManifest({ ...f.manifest, files: [{ ...f.manifest.files[0], ...patch }, ...f.manifest.files.slice(1)] }));
  }
});
test('preview is read-only and first install copies exact bytes without modifying separate user config', t => {
  const f = fixture(t);
  const userConfig = path.join(f.root, '.sunmoon-link'); fs.mkdirSync(userConfig);
  fs.writeFileSync(path.join(userConfig, 'config.json'), 'synthetic-config-keep');
  const before = inventory(f.root);
  const preview = firstInstall(f);
  assert.equal(preview.action, 'preview');
  assert.deepEqual(inventory(f.root), before);
  assert.equal(preview.startsAgent, false); assert.equal(preview.registersLogonTask, false);
  assert.equal(preview.needsAdministrator, false); assert.equal(preview.changesUserConfig, false);
  const installed = firstInstall({ ...f, apply: true });
  assert.equal(installed.action, 'installed');
  assert.deepEqual(inventory(installed.destination), inventory(f.source));
  assert.equal(fs.readFileSync(path.join(userConfig, 'config.json'), 'utf8'), 'synthetic-config-keep');
  assert.throws(() => firstInstall({ ...f, apply: true }), /already exists/);
});
test('existing empty directory is not replaced or removed', t => {
  const f = fixture(t), target = path.join(f.localAppData, 'Programs/sunmoon-link');
  fs.mkdirSync(target, { recursive: true });
  assert.throws(() => firstInstall({ ...f, apply: true }), /already exists/);
  assert.deepEqual(fs.readdirSync(target), []);
});
test('copy interruption keeps an incomplete marker and refuses a blind second install', t => {
  const f = fixture(t), originalCopy = fs.copyFileSync;
  let copies = 0;
  fs.copyFileSync = (...args) => { if (++copies === 3) throw new Error('synthetic copy interruption'); return originalCopy(...args); };
  try { assert.throws(() => firstInstall({ ...f, apply: true }), /synthetic copy interruption/); }
  finally { fs.copyFileSync = originalCopy; }
  const target = path.join(f.localAppData, 'Programs/sunmoon-link');
  assert.equal(fs.existsSync(path.join(target, '.install-incomplete')), true);
  assert.equal(fs.existsSync(path.join(target, 'sunmoon-link.cmd')), false);
  assert.throws(() => firstInstall({ ...f, apply: true }), /already exists/);
});
test('source-destination nesting is refused', t => {
  const f = fixture(t);
  assert.throws(() => firstInstall({ ...f, localAppData: f.source }), /overlap/);
});
test('junction/directory-link in Programs is refused, target untouched', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.localAppData, 'Programs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => firstInstall({ ...f, apply: true }), /link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('bundle directory links are rejected', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.source, 'untrusted'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => verifyBundle(f.source, f.expectedManifestHash), /links/);
});
test('installer refuses unsupported switches rather than accidentally applying', () => {
  const entry = fileURLToPath(new URL('../install.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--apply-now'], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Unknown option/);
});
test('only explicit source inputs are included by builder; launcher uses bundled node', () => {
  const builder = fs.readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(builder, /os\.homedir|process\.env\.USERPROFILE|execSync|shell: true/);
  assert.match(builder, /writeSite/); assert.match(builder, /--site/);
  for (const file of ['sunmoon-link.cmd', 'install.cmd', 'uninstall.cmd']) {
    const cmd = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(cmd, /%~dp0node\\node.exe/); assert.match(cmd, /--use-system-ca/);
    assert.match(cmd, /NODE_OPTIONS=/); assert.match(cmd, /bundled-ca/);
    assert.doesNotMatch(cmd, /call :launch|\bnpm\b|\bpnpm\b|powershell|ExecutionPolicy/);
  }
  const ps1 = fs.readFileSync(new URL('../../native/desktop.ps1', import.meta.url), 'utf8');
  const vbs = fs.readFileSync(new URL('../../native/run-hidden.vbs', import.meta.url), 'utf8');
  const opener = fs.readFileSync(new URL('../../native/open-desktop.vbs', import.meta.url), 'utf8');
  for (const source of [ps1, vbs, opener]) {
    assert.match(source, /--use-system-ca/); assert.match(source, /NODE_OPTIONS/); assert.match(source, /bundled-ca/);
  }
  assert.match(ps1, /lastError/); assert.match(ps1, /63/);
  // 0.3.2：分离启动（托盘「重新连接账号」）不重定向 stdout 时必须清掉编码，否则 Process.Start 抛异常
  assert.match(ps1, /if\(\$Detached\)\{[^}]*\$Info\.StandardOutputEncoding=\$null\}/);
  assert.match(ps1, /'\/\/B \/\/Nologo "' \+ \$InputData\.hiddenScript \+ '" "' \+ \$InputData\.node \+ '" "' \+ \$InputData\.cli \+ '" "' \+ \$InputData\.state \+ '"'/);
});

const devCa = fs.readFileSync(new URL('../sites/dev-kind-ca.pem', import.meta.url), 'utf8');
const devProfile = JSON.parse(fs.readFileSync(new URL('../sites/dev-kind.json', import.meta.url), 'utf8'));
test('dev site CA is the registry local CA and its DER hash is written only at pack time', t => {
  assert.equal(devCa.includes('PRIVATE KEY'), false);
  assert.equal(certificateDerSha256(devCa), '76f9012886262cf6974039de8baf16ecd5e79e780237349fdcb95a2ac1aa1b3c');
  assert.equal(devProfile.trust.ca_sha256, undefined);
  assert.throws(() => siteDocument({ ...devProfile, trust: { ...devProfile.trust, ca_sha256: 'a'.repeat(64) } }, 'unused'), /computed/);
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sunmoon-site-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pem = path.join(root, 'ca.pem'); fs.writeFileSync(pem, devCa);
  const written = writeSite(root, devProfile, pem);
  assert.equal(written.trust.ca_sha256, certificateDerSha256(devCa));
  assert.match(fs.readFileSync(path.join(root, 'site', 'site.json'), 'utf8'), /"mode": "bundled-ca"/);
  const f = fixture(t);
  fs.cpSync(path.join(root, 'site'), path.join(f.source, 'site'), { recursive: true });
  const reseal = () => { fs.rmSync(path.join(f.source, MANIFEST)); f.manifest.files = inventory(f.source); return f.save(); };
  assert.equal(verifyBundle(f.source, reseal()).agentVersion, '0.2.0');
  const siteFile = path.join(f.source, 'site', 'site.json');
  const site = JSON.parse(fs.readFileSync(siteFile, 'utf8')); site.trust.ca_sha256 = '0'.repeat(64);
  fs.writeFileSync(siteFile, JSON.stringify(site));
  assert.throws(() => verifyBundle(f.source, reseal()), /Site CA digest mismatch/);
});

function shaped(t, agentVersion, omit) {
  const f = fixture(t);
  for (const name of omit) fs.rmSync(path.join(f.source, name), { force: true });
  fs.rmSync(path.join(f.source, MANIFEST));
  f.manifest.agentVersion = agentVersion;
  f.manifest.files = inventory(f.source);
  f.expectedManifestHash = f.save();
  return f;
}

test('an installed 0.2.1-shaped tree is removed from its own manifest and a new package still requires the current layout', t => {
  const old = shaped(t, '0.2.1', ['installer/launch.mjs', 'installer/upgrade.mjs']);
  assert.equal(fs.existsSync(path.join(old.source, 'site')), false);
  assert.throws(() => verifyBundle(old.source, old.expectedManifestHash), /Incomplete or oversized bundle/);
  assert.throws(() => firstInstall({ ...old, apply: true }), /Incomplete or oversized bundle/);
  assert.equal(fs.existsSync(path.join(old.localAppData, 'Programs')), false);
  const installed = path.join(old.root, 'installed-021');
  fs.cpSync(old.source, installed, { recursive: true });
  const outside = path.join(old.root, 'kept-config.json');
  fs.writeFileSync(outside, 'synthetic-config-keep');
  const found = inspectInstalled(installed);
  assert.equal(found.installedVersion, '0.2.1');
  assert.equal(found.installedManifestSha256, old.expectedManifestHash);
  assert.deepEqual(decideUpgrade(found.installedVersion, '0.2.2'), { action: 'upgrade', preserveConfig: true, installedVersion: '0.2.1' });
  removeVerifiedBundle(installed, found.installedManifestSha256, true);
  assert.equal(fs.existsSync(installed), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic-config-keep');
});

test('uninstall clears a dead leftover tray stop on a 0.2.1 tree before the old CLI and keeps config', t => {
  const old = shaped(t, '0.2.1', ['installer/launch.mjs', 'installer/upgrade.mjs']);
  const installed = path.join(old.root, 'installed-021-tray');
  fs.cpSync(old.source, installed, { recursive: true });
  const state = path.join(old.root, 'state');
  fs.mkdirSync(state);
  const run = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const stop = path.join(state, 'tray-stop.json');
  const tray = path.join(state, 'tray.json');
  fs.writeFileSync(path.join(state, 'config.json'), 'synthetic-config-keep');
  fs.writeFileSync(stop, JSON.stringify({ pid: 424242, runId: run }));
  fs.writeFileSync(tray, JSON.stringify({ pid: 424242, runId: run }));
  assert.equal(clearStaleTray(state, () => true), 'pending');
  assert.equal(fs.existsSync(stop), true);
  assert.equal(clearStaleTray(state, () => false), 'cleared');
  assert.equal(fs.existsSync(stop), false);
  assert.equal(fs.existsSync(tray), false);
  removeVerifiedBundle(installed, inspectInstalled(installed).installedManifestSha256, true);
  assert.equal(fs.existsSync(installed), false);
  assert.equal(fs.readFileSync(path.join(state, 'config.json'), 'utf8'), 'synthetic-config-keep');
  const linked = path.join(old.root, 'linked');
  fs.mkdirSync(linked);
  const target = path.join(linked, 'target.json');
  fs.writeFileSync(target, JSON.stringify({ pid: 1, runId: run }));
  const linkTarget=process.platform==='win32'?path.join(linked,'target-dir'):target;
  if(process.platform==='win32'){
    fs.mkdirSync(linkTarget);
    fs.writeFileSync(path.join(linkTarget,'target.json'),fs.readFileSync(target));
  }
  fs.symlinkSync(linkTarget, path.join(linked, 'tray-stop.json'),process.platform==='win32'?'junction':undefined);
  assert.throws(() => clearStaleTray(linked, () => false), /Unsafe tray status/);
  const linkedFile=process.platform==='win32'?path.join(linked,'tray-stop.json','target.json'):path.join(linked,'tray-stop.json');
  assert.equal(fs.readFileSync(linkedFile, 'utf8'), fs.readFileSync(target, 'utf8'));
  const script = fs.readFileSync(fileURLToPath(new URL('../uninstall.mjs', import.meta.url)), 'utf8');
  const clearAt = script.indexOf('clearStaleTray(state, pidAlive)');
  const trayAt = script.indexOf("for (const args of [['tray','stop'],['stop']])");
  assert.equal(clearAt > 0 && clearAt < trayAt, true);
});

test('0.2.2 and same-version decisions keep config and never replace a newer install', t => {
  const current = shaped(t, '0.2.2', []);
  const found = inspectInstalled(current.source);
  assert.equal(found.installedVersion, '0.2.2');
  assert.deepEqual(decideUpgrade('0.2.2', '0.2.2'), { action: 'open', preserveConfig: true, installedVersion: '0.2.2' });
  assert.deepEqual(decideUpgrade('0.2.1', '0.2.2'), { action: 'upgrade', preserveConfig: true, installedVersion: '0.2.1' });
  assert.deepEqual(decideUpgrade('0.2.2', '0.2.3'), { action: 'upgrade', preserveConfig: true, installedVersion: '0.2.2' });
  assert.deepEqual(decideUpgrade('0.2.3', '0.2.2'), { action: 'refuse', preserveConfig: true, installedVersion: '0.2.3' });
  assert.deepEqual(decideUpgrade(null, '0.2.2'), { action: 'install', preserveConfig: true });
  assert.equal(fs.existsSync(path.join(current.source, 'installer/launch.mjs')), true);
});

test('onboard is retired and every retained visible form uses common visibility handling',()=>{
  const text=fs.readFileSync(new URL('../../native/desktop.ps1',import.meta.url),'utf8');
  assert.ok(!text.includes('Show-Onboard'));
  assert.equal(text.split('Initialize-VisibleForm $Dialog').length,3);
  assert.ok(text.includes('Initialize-VisibleForm $Form'));
  const vbs=fs.readFileSync(new URL('../../native/open-desktop.vbs',import.meta.url),'utf8');
  assert.ok(!vbs.includes('onboard'));
});

test('install script upgrades either installed shape without an overwrite switch', () => {
  const template = fileURLToPath(new URL('../install.ps1.tmpl', import.meta.url));
  const bytes = fs.readFileSync(template);
  assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, false);
  const text = bytes.toString('utf8');
  const names = ['PACKAGE_URL', 'VERSION', 'SIZE_BYTES', 'ZIP_SHA256', 'MANIFEST_SHA256', 'CODEX_VERSION'];
  for (const name of names) assert.equal(text.split(`{{${name}}}`).length - 1, 1, name);
  const leftover = text.replace(/\{\{(?:PACKAGE_URL|VERSION|SIZE_BYTES|ZIP_SHA256|MANIFEST_SHA256|CODEX_VERSION)\}\}/g, '');
  assert.equal(/\{\{[A-Z0-9_]+\}\}/.test(leftover), false);
  assert.match(text, /installer\\upgrade\.mjs/);
  assert.match(text, /installer\\uninstall\.mjs/);
  assert.match(text, /installer\\install\.mjs/);
  assert.equal(text.includes('--remove-config'), false);
  assert.equal(text.includes('ExecutionPolicy'), false);
  assert.match(text, /安装目录还在，没有覆盖已有安装/);
  assert.match(text, /SunMoon link/);
  assert.match(text, /Test-Path -LiteralPath \$ConfigPath/);
  assert.match(text, /autostart enable/);
  assert.match(text, /还没颁发过令牌的电脑会自动打开浏览器颁发令牌页；已经颁发过的直接用托盘/);
  const desktop = fs.readFileSync(fileURLToPath(new URL('../../native/desktop.ps1', import.meta.url)), 'utf8');
  for (const label of ['重新颁发令牌', 'pair-page-status', '本机颁发令牌页', '确认码：']) {
    assert.equal(desktop.includes(label), true, label);
  }
  const page=fs.readFileSync(new URL('../../src/pairPage.ts',import.meta.url),'utf8');
  for(const label of ['不选的话工作和专家碰不到你的文件','登录时自动运行已打开','已在线','重新获取'])assert.ok(page.includes(label),label);
  // No runspace callbacks or pairing state files remain in the desktop process.
  for (const banned of ['add_OutputDataReceived', 'add_ErrorDataReceived', 'BeginOutputReadLine', 'BeginErrorReadLine']) {
    assert.equal(desktop.includes(banned), false, banned);
  }
});
