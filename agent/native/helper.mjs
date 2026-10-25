// Windows Node helper, launched inside Codex's sandbox. No compilation or FFI.
// OS sandbox enforces writes; directory pins and file identity enforce reads.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownedMcp, mcpToml } from '../dist/mcp.js';
if (process.platform !== 'win32') throw new Error('Windows only');
const normal = p => {
  if (typeof p !== 'string' || !/^[a-z]:[\\/]/i.test(p) || /[\x00-\x1f]/.test(p)) throw new Error('local path required');
  for (const bit of p.replaceAll('/', '\\').slice(3).split('\\')) {
    if (bit === '.' || bit === '..') continue;
    if (/[. ]$|[<>:"|?*]|~[0-9]/.test(bit) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(bit)) throw new Error('path alias refused');
  }
  return path.normalize(p).toLowerCase();
};
const under = (p, r) => { const rel = path.relative(normal(r), normal(p)); return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !path.isAbsolute(rel)); };
// Windows holds its current directory AND ancestors against rename. Check after
// chdir, while that handle is held, not before a raceable realpath/open pair.
function inspectDirectory(p) {
  for (;;) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink() || normal(fs.realpathSync(p)) !== normal(p)) throw new Error('directory alias refused');
    const parent = path.dirname(p); if (parent === p) break; p = parent;
  }
}
if (process.argv[2] === '--pin-directory') {
  inspectDirectory(process.cwd()); process.stdout.write('{"ready":true}\n');
  process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
} else {
  const cfg = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  const handles = new Map();
  const missing = (error, kind) => {
    const response = cfg.notFound?.[kind];
    if (error.code === 'ENOENT' && response?.code === -32004) return Object.assign(error, { rpcCode: response.code, rpcMessage: response.message });
    return error;
  };
  const policy = (p, write = false) => {
    normal(p);
    if (!(write ? cfg.roots : cfg.reads).some(r => under(p, r)) || cfg.deniedReads.some(r => under(p, r))) throw new Error('outside roots');
    return p;
  };
  const local = (uri, write = false) => {
    const u = new URL(uri); if (u.protocol !== 'file:' || u.host || u.search || u.hash) throw new Error('local URI required');
    return policy(fileURLToPath(u), write);
  };
  function inDirectory(dir, fn) {
    const old = process.cwd();
    try {
      try { process.chdir(dir); }
      catch (error) {
        if (error.code !== 'ENOENT' || path.dirname(dir) === dir) throw error;
        // Validate/pin the nearest existing ancestor before treating absence as
        // benign. A dangling link or alias must remain a policy refusal.
        return inDirectory(path.dirname(dir), () => {
          try { info(dir); } catch (absent) { throw missing(absent, 'directory'); }
          throw error;
        });
      }
      inspectDirectory(dir); const a = fs.statSync('.', { bigint: true }), b = fs.statSync(dir, { bigint: true }); if (a.dev !== b.dev || a.ino !== b.ino) throw new Error('directory identity refused'); return fn();
    }
    finally { process.chdir(old); }
  }
  function info(p) {
    let s; try { s = fs.lstatSync(p); } catch (error) { throw missing(error, 'file'); }
    if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) throw new Error('link or special file refused');
    return s;
  }
  function openRead(p) {
    policy(p);
    return inDirectory(path.dirname(p), () => {
      info(p);
      let fd;
      try { fd = fs.openSync(p, 'r'); }
      catch (error) { info(p); throw error; }
      try {
        const opened = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(p, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || opened.dev !== named.dev || opened.ino !== named.ino || normal(fs.realpathSync(p)) !== normal(p)) throw new Error('file identity refused');
        return fd; // No bytes read until the opened file identity is checked.
      } catch (e) { fs.closeSync(fd); throw e; }
    });
  }
  function read(p) {
    const fd = openRead(p);
    try { const size = fs.fstatSync(fd).size; if (size > 8 * 1024 * 1024) throw new Error('use readBlock'); const b = Buffer.alloc(size); return b.subarray(0, fs.readSync(fd, b, 0, size, 0)); }
    finally { fs.closeSync(fd); }
  }
  function write(p, data) {
    policy(p, true);
    return inDirectory(path.dirname(p), () => {
      try { if (!info(p).isFile()) throw new Error('not file'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.writeFileSync(p, data); // Ordinary write. OS sandbox is the authority.
    });
  }
  function mkdir(p, recursive) {
    policy(p, true); const parent = path.dirname(p);
    if (recursive && !fs.existsSync(parent)) mkdir(parent, true);
    return inDirectory(parent, () => { fs.mkdirSync(p, { recursive }); inDirectory(p, () => {}); });
  }
  function remove(p, recursive, force) {
    policy(p, true);
    return inDirectory(path.dirname(p), () => {
      try { info(p); } catch (e) { if (force && e.code === 'ENOENT') return; throw e; }
      fs.rmSync(p, { recursive, force });
    });
  }
  function copy(a, b, recursive) {
    policy(a); policy(b, true);
    return inDirectory(path.dirname(a), () => {
      if (info(a).isDirectory()) {
        if (!recursive || under(b, a)) throw new Error('unsafe recursive copy');
        return inDirectory(a, () => { mkdir(b, true); for (const name of fs.readdirSync(a)) copy(path.join(a, name), path.join(b, name), true); });
      }
      write(b, read(a));
    });
  }
  function metadata(p) {
    policy(p);
    // 白名单根本身：进它自己核身份。它的上级（用户目录）沙箱账户进不去（账 177）
    const inspectFrom = cfg.reads.some(r => normal(r) === normal(p)) ? p : path.dirname(p);
    return inDirectory(inspectFrom, () => { const s = info(p); return { isDirectory: s.isDirectory(), isFile: s.isFile(), isSymlink: false, size: s.size, createdAtMs: Math.trunc(s.birthtimeMs), modifiedAtMs: Math.trunc(s.mtimeMs) }; });
  }
  function walk(p, o) {
    if (!o || ['maxDepth', 'maxDirectories', 'maxEntries'].some(k => !Number.isSafeInteger(o[k]) || o[k] < 0) || o.maxDepth > 128 || o.maxDirectories > 10000 || o.maxEntries > 10000 || o.followDirectorySymlinks) throw new Error('walk bounds refused');
    const result = { entries: [], errors: [], truncated: false }; let visited = 0;
    const queue = [{ dir: p, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      policy(dir); if (visited++ >= o.maxDirectories) { result.truncated = true; break; }
      inDirectory(dir, () => { for (const name of fs.readdirSync(dir)) {
        if (result.entries.length >= o.maxEntries) { result.truncated = true; return; }
        const target = path.join(dir, name);
        try { const m = metadata(target); result.entries.push({ path: pathToFileURL(target).href, kind: m.isDirectory ? 'directory' : 'file' }); if (m.isDirectory && depth < o.maxDepth && !(o.pruneHiddenDirectories && name.startsWith('.'))) queue.push({ dir: target, depth: depth + 1 }); }
        catch { result.errors.push({ path: pathToFileURL(target).href, message: 'entry refused or unavailable' }); }
      } });
    }
    return result;
  }
  function dispatch(method, p) {
    const target = p.path ? local(p.path, ['fs/writeFile', 'fs/createDirectory', 'fs/remove'].includes(method)) : null;
    switch (method) {
      // Private service projection: same pins/identity checks as Codex FS, no
      // write operations, handles or executable parameters exposed remotely.
      case 'service/getMetadata': {
        const m = metadata(target);
        return { type: m.isDirectory ? 'dir' : m.isFile ? 'file' : 'other', size: m.size, mtime: m.modifiedAtMs };
      }
      case 'service/readDirectory': return inDirectory(target, () => {
        const entries = []; let truncated = false, bytes = 512;
        const dir = fs.opendirSync(target);
        try {
          let entry;
          while ((entry = dir.readSync())) {
            const s = fs.lstatSync(path.join(target, entry.name));
            const item = { name: entry.name, type: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size, mtime: Math.trunc(s.mtimeMs) };
            bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
            if (entries.length >= 2000 || bytes > 1024 * 1024 - 2048) { truncated = true; break; }
            entries.push(item); // Never resolve a listed link.
          }
        } finally { dir.closeSync(); }
        return { entries, truncated };
      });
      case 'service/readFile':
      case 'local/readFile': {
        const limit = method === 'local/readFile' ? 1048576 : 524288;
        if (!Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.length) || p.length < 1 || p.length > limit) throw Object.assign(new Error('invalid range'), { rpcCode: -32602, rpcMessage: 'Invalid params' });
        const fd = openRead(target);
        try {
          const s = fs.fstatSync(fd);
          if (s.size > 64 * 1024 * 1024) throw Object.assign(new Error('too_large'), { rpcCode: -32011, rpcMessage: 'too_large' });
          const b = Buffer.alloc(Math.min(p.length, Math.max(0, s.size - p.offset))), n = fs.readSync(fd, b, 0, b.length, p.offset);
          return { content: b.subarray(0, n).toString('base64'), size: s.size, mtime: Math.trunc(s.mtimeMs), eof: p.offset + n >= s.size };
        } finally { fs.closeSync(fd); }
      }
      case 'environmentConfig/read': {
        const selection = v => Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1 && v[0][0] === 'mcp_servers';
        if (!selection(p.configPaths) || !selection(p.requirementsPaths)) throw new Error('config projection refused');
        // Only our current generated, credential-free file. No generic loader
        // that could merge .codex, global config or requirements from elsewhere.
        const text = read(path.join(cfg.home, 'config.toml')).toString('utf8');
        const servers = ownedMcp(text), toml = mcpToml(servers);
        const layers = toml ? [{ source: `user (${path.join(cfg.home, 'config.toml')})`, baseDir: pathToFileURL(cfg.home).href, toml }] : [];
        return { userHomeDir: pathToFileURL(os.homedir()).href, codexHomeDir: pathToFileURL(cfg.home).href, hostname: os.hostname(), config: { layers, cloudInsertionIndex: 0 }, requirements: { layers: [], cloudInsertionIndex: 0 } };
      }
      case 'fs/readFile': return { dataBase64: read(target).toString('base64') };
      case 'fs/writeFile': {
        if (typeof p.dataBase64 !== 'string') throw new Error('invalid base64');
        const data = Buffer.from(p.dataBase64, 'base64');
        if (data.toString('base64') !== p.dataBase64) throw new Error('invalid base64');
        write(target, data); return {};
      }
      case 'fs/createDirectory': mkdir(target, p.recursive === true); return {};
      case 'fs/remove': remove(target, p.recursive === true, p.force === true); return {};
      case 'fs/copy': copy(local(p.sourcePath), local(p.destinationPath, true), p.recursive === true); return {};
      case 'fs/getMetadata': return metadata(target);
      case 'fs/canonicalize': metadata(target); return { path: pathToFileURL(target).href };
      case 'fs/readDirectory': return inDirectory(target, () => ({ entries: fs.readdirSync(target).map(name => { const m = metadata(path.join(target, name)); return { fileName: name, isDirectory: m.isDirectory, isFile: m.isFile }; }) }));
      case 'fs/walk': return walk(target, p.options);
      case 'fs/open': {
        if (typeof p.handleId !== 'string' || !p.handleId || handles.has(p.handleId) || handles.size >= 64) throw new Error('invalid handle');
        handles.set(p.handleId, openRead(target)); return { handleId: p.handleId };
      }
      case 'fs/readBlock': {
        if (!Number.isSafeInteger(p.len) || p.len < 1 || p.len > 1024 * 1024) throw Object.assign(new Error('invalid block length'), { rpcCode: -32600, rpcMessage: 'file read block length must be between 1 and 1048576' });
        const fd = handles.get(p.handleId);
        if (fd === undefined || !Number.isSafeInteger(p.offset) || p.offset < 0) throw new Error('invalid block');
        const stat = fs.fstatSync(fd); if (stat.nlink !== 1) throw new Error('file links changed');
        const b = Buffer.alloc(p.len), n = fs.readSync(fd, b, 0, b.length, p.offset);
        return { chunk: b.subarray(0, n).toString('base64'), eof: n < p.len };
      }
      case 'fs/close': { const fd = handles.get(p.handleId); if (fd === undefined) throw new Error('unknown handle'); fs.closeSync(fd); handles.delete(p.handleId); return {}; }
      default: throw new Error('unknown method');
    }
  }
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    let id = null;
    try { if (line.length > 12 * 1024 * 1024) throw new Error('frame too large'); const f = JSON.parse(line); id = f.id; process.stdout.write(JSON.stringify({ id, result: dispatch(f.method, f.params) }) + '\n'); }
    catch (e) { process.stdout.write(JSON.stringify({ id, error: e.rpcCode ? { code: e.rpcCode, message: e.rpcMessage } : { code: -32001, message: 'sunmoon-agent local ceiling: filesystem operation refused or unavailable', data: { reason: e.code ?? (e.message.includes('refused') ? e.message : 'invalid operation'), syscall: e.syscall } } }) + '\n'); }
  });
  lines.on('close', () => { for (const fd of handles.values()) fs.closeSync(fd); });
}
