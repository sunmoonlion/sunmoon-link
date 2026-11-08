// Stand-in for native/helper.mjs inside the sandbox, for WindowsFiles tests.
// argv[2] picks the behaviour:
//   echo      answer every line at once (healthy resident)
//   eof-only  hold every line until stdin ends, then answer (the 11-01 symptom)
//   stall     answer the ping, never anything else
//   crash     answer the ping, exit on the next request
import readline from "node:readline";

const mode = process.argv[2];
const answer = (f) => process.stdout.write(JSON.stringify({ id: f.id, result: { method: f.method, pid: process.pid, params: f.params } }) + "\n");
const held = [];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const f = JSON.parse(line);
  if (mode === "eof-only") { held.push(f); return; }
  if (f.method === "sunmoon/ping") { answer(f); return; }
  if (mode === "stall") return;
  if (mode === "crash") process.exit(3);
  answer(f);
});
lines.on("close", () => { for (const f of held) answer(f); });
