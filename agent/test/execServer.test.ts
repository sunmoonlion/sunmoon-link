import { describe, expect, it } from "vitest";
import { execServerCommand } from "../src/execServer.js";

describe("execServerCommand", () => {
  it("turns on concurrent request dispatch so batched metadata probes do not queue on the user's computer", () => {
    expect(execServerCommand("/x/codex", "ws://127.0.0.1:1")).toEqual(["/x/codex", "exec-server", "--concurrent-requests", "8", "--listen", "ws://127.0.0.1:1"]);
  });
});
