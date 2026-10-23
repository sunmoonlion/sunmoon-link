import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { describe, it, expect } from "vitest";
import { killWindowsTree, windowsProfile } from "../src/windowsRuntime.js";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(50); } throw new Error("condition timeout"); }
const CLI = path.resolve(__dirname, "../dist/cli.js");

describe.skipIf(process.platform !== "win32")("Windows CLI real lifecycle + loopback relay", () => {
  it("initializes, filters, runs commands, survives 20s relay loss, reports revocation and cleans executor tree", async () => {
    const base = fs.mkdtempSync(path.join(os.homedir(), "sunmoon-native-lifecycle-"));
    const home = path.join(base, "agent"); const root = path.join(base, "workspace");fs.mkdirSync(root); const state = path.join(home, "status.json");
    let server: WebSocketServer | undefined, control: WebSocket | undefined, data: WebSocket | undefined, child: ChildProcess | undefined;
    let port = 0; let stderr = ""; let helloCount = 0; const received: any[] = [];
    const listen = async () => {
      server = new WebSocketServer({ host: "127.0.0.1", port });
      await new Promise<void>(r => server!.once("listening", r)); port = (server.address() as net.AddressInfo).port;
      server.on("connection", (ws, req) => {
        ws.once("message", raw => { const h = JSON.parse(String(raw));
          if (req.url === "/agent") { control = ws; helloCount++; ws.send(JSON.stringify({ type: "welcome", proto: 1, relay: "native-test" })); }
          else { data = ws; ws.on("message", raw => received.push(JSON.parse(String(raw)))); }
        });
      });
    };
    const stopServer = async () => { for (const c of server!.clients) c.terminate(); await new Promise<void>(r => server!.close(() => r())); };
    let id = 0;
    const call = async (method: string, params: any) => { const seq = ++id; data!.send(JSON.stringify({ id: seq, method, params })); await until(() => received.some(f => f.id === seq)); return received.find(f => f.id === seq); };
    try {
      await listen(); const env = { ...process.env, SUNMOON_AGENT_HOME: home };
      const init = spawnSync(process.execPath, [CLI, "init", "--relay", `ws://127.0.0.1:${port}`, "--user", "test-user", "--token", "test-only-not-a-credential", "--root", root, "--name", "windows-native-lifecycle"], { env, encoding: "utf8", timeout: 20000, windowsHide: true });
      expect(init.status, init.stderr).toBe(0);
      const unchecked=path.join(base,"unchecked");fs.mkdirSync(unchecked);fs.writeFileSync(path.join(unchecked,"private.txt"),"not shared");
      const configFile=path.join(home,"config.json"),config=JSON.parse(fs.readFileSync(configFile,"utf8"));
      config.rootChoices=[root,unchecked];fs.writeFileSync(configFile,JSON.stringify(config));
      child = spawn(process.execPath, [CLI, "start"], { env, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] }); child.stderr!.on("data", d => { stderr += String(d); });
      await until(() => fs.existsSync(state) && JSON.parse(fs.readFileSync(state, "utf8")).relay.status === "connected");
      const first = JSON.parse(fs.readFileSync(state, "utf8")); expect(first.execServer.windowsSandbox.mode).toBe("unelevated"); expect(first.execServer.sandboxed).toBe(false); expect(first.execServer.protection).toBe("inner-sandbox+strict-protocol");
      control!.send(JSON.stringify({ type: "open", conn: "test-native-1" })); await until(() => !!data);
      expect((await call("initialize", { clientName: "native-cli-test" })).result.environmentInfo.executorVersion).toBe("0.155.1"); data!.send(JSON.stringify({ method: "initialized", params: {} }));
      const target = path.join(root, "via-relay.txt");
      expect((await call("fs/writeFile", { path: pathToFileURL(target).href, dataBase64: "YnJpZGdl" })).result).toEqual({});expect(fs.readFileSync(target, "utf8")).toBe("bridge");
      expect((await call("fs/readFile",{path:pathToFileURL(path.join(unchecked,"private.txt")).href})).error.code).toBe(-32001);
      expect((await call("fs/writeFile",{path:pathToFileURL(path.join(unchecked,"blocked.txt")).href,dataBase64:"YmFk"})).error.code).toBe(-32001);
      expect(fs.existsSync(path.join(unchecked,"blocked.txt"))).toBe(false);
      const threadId = "01a116d9-d2f4-77f3-8f14-4deb4d373f33";
      const sandbox = windowsProfile(root, [root], "unelevated");
      (sandbox.permissions.file_system.entries as any[]).push({ path: { type: "path", path: pathToFileURL(path.join(root, ".codex")).href }, access: "read", missing_path_behavior: "skip" });
      const request = { processId: "remote-1", metadata: { threadId, toolCallId: "native-lifecycle" }, argv: [globalThis.process.execPath, "-e", "require('fs').writeFileSync('command.txt','ran');require('fs').writeFileSync('env-check.json',JSON.stringify({home:process.env.CODEX_HOME,clientMarker:process.env.CODEX_CI??null,pathPresent:!!process.env.PATH}))"], tty: false,
        envPolicy: { inherit: "all", ignoreDefaultExcludes: true, exclude: ["CODEX_VERSION"], set: {}, includeOnly: [] },
        env: { CODEX_THREAD_ID: threadId, CODEX_SESSION_ID: threadId, CODEX_VERSION: "0.155.1", CODEX_CI: "1", CODEX_SANDBOX_NETWORK_DISABLED: "1" }, cwd: pathToFileURL(root).href, sandbox };
      expect((await call("process/start", request)).result.sandboxType).toBe("windowsRestrictedToken"); await until(() => fs.existsSync(path.join(root, "command.txt")));
      await until(() => fs.existsSync(path.join(root, "env-check.json")));
      expect(JSON.parse(fs.readFileSync(path.join(root, "env-check.json"), "utf8"))).toEqual({ home: JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")).codexHome, clientMarker: null, pathPresent: true });
      expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
      expect((await call("process/start", { ...request, processId: "unsafe", sandbox: null })).error.code).toBe(-32001);
      const readOnly = { ...request, processId: "read-only", argv: [globalThis.process.execPath, "-e", "require('fs').writeFileSync('read-only.txt','bad')"], sandbox: windowsProfile(root, [root], "unelevated", false) };
      expect((await call("process/start", readOnly)).result.sandboxType).toBe("windowsRestrictedToken"); await until(() => received.some(f => f.method === "process/exited" && f.params.processId === "read-only")); expect(fs.existsSync(path.join(root, "read-only.txt"))).toBe(false);
      // Local ceiling is still enforced when caller's cwd/mode look acceptable.
      const widened = structuredClone(request);widened.processId="widened";widened.sandbox.permissions.file_system.entries.push({ path: { type: "path", path: pathToFileURL(base).href }, access: "write" });
      expect((await call("process/start", widened)).error.code).toBe(-32001);
      expect((await call("fs/readFile", { path: pathToFileURL(path.join(home, "config.json")).href })).error.code).toBe(-32001);
      await stopServer(); await sleep(20000); await listen(); await until(() => helloCount >= 2, 35000); await sleep(5200);
      const second = JSON.parse(fs.readFileSync(state, "utf8")); expect(second.execServer.url).toBe(first.execServer.url); expect(second.execServer.generation).toBe(first.execServer.generation);expect(second.pid).toBe(first.pid);
      // A real descendant must disappear too, not merely the listening port.
      data = undefined; control!.send(JSON.stringify({ type: "open", conn: "test-native-2" })); await until(() => !!data);
      expect((await call("initialize", { clientName: "native-cleanup-test" })).result.environmentInfo.executorVersion).toBe("0.155.1"); data!.send(JSON.stringify({ method: "initialized", params: {} }));
      const marker = path.join(root, "descendants.json");
      const treeCode = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('descendants.json',JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000)";
      expect((await call("process/start", { ...request, processId: "tree", argv: [process.execPath, "-e", treeCode] })).result.sandboxType).toBe("windowsRestrictedToken");
      await until(() => fs.existsSync(marker)); const descendants = JSON.parse(fs.readFileSync(marker, "utf8"));
      expect(Number.isInteger(descendants.child)).toBe(true); expect(() => process.kill(descendants.child, 0)).not.toThrow();
      control!.close(4003, "test revocation"); await until(() => child!.exitCode !== null, 15000); expect(child.exitCode, stderr).toBe(3);
      for (const pid of [descendants.parent, descendants.child]) expect(() => process.kill(pid, 0)).toThrow();
      const final = JSON.parse(fs.readFileSync(state, "utf8"));expect(final.relay.status).toBe("rejected");expect(final.relay.lastError).toContain("4003");expect(final.relay.lastError).toContain("重新颁发令牌");expect(JSON.stringify(final)+stderr).not.toContain("test-only-not-a-credential");
      const closed = await new Promise<boolean>(resolve => { const socket = net.connect(Number(new URL(first.execServer.url).port), "127.0.0.1");socket.once("connect",()=>{socket.destroy();resolve(false)});socket.once("error",()=>resolve(true)); });expect(closed).toBe(true);
    } finally { if(child && child.exitCode===null)await killWindowsTree(child);if(server)await stopServer().catch(()=>{});fs.rmSync(base,{recursive:true,force:true}); }
  }, 100000);
});
