import { describe, expect, it } from "vitest";
import { humanizeClose, humanizeReject, humanizeTransport } from "../src/connectionMessages.js";
import { rejectionInfo } from "../src/rejections.js";

const CERT = "这台电脑不信任站点证书。请重新从网页下载安装包；若仍出现，联系管理员。";
const EXPIRED = "令牌已失效，请在托盘点『重新颁发令牌』。";
const REPLACED = "这个账号的令牌已颁发给另一份本地 link，这台已断开。";
const HOST = "relay.sunmoonai.com";

describe("connection sentences", () => {
  it("maps each TLS failure to the certificate sentence and keeps the original code", () => {
    for (const code of ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      const info = humanizeTransport({ code, message: "fixture-token-must-not-appear" }, HOST);
      expect(info.message).toBe(`${code}: ${CERT}`);
      expect(info.message).not.toContain("fixture-token");
    }
  });
  it.each([
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("maps %s to the certificate sentence", (code) => {
    const info = humanizeTransport({ code, message: "fixture-token-must-not-appear" }, HOST);
    expect(info.message).toBe(`${code}: ${CERT}`);
    expect(info.message).not.toContain("检查网络");
    expect(info.message).not.toContain("fixture-token");
  });
  it("maps unreachable hosts and timeouts without copying the raw message", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(humanizeTransport({ code, message: "token=fixture" }, HOST).message).toBe(`${code}: 连不上 ${HOST}。检查网络或代理设置。`);
    }
    expect(humanizeTransport({ message: "connect timed out" }, HOST).message).toBe("ETIMEDOUT: 连不上 relay.sunmoonai.com。检查网络或代理设置。");
    expect(humanizeTransport({ code: "ENOTFOUND" }, "not a host").message).toContain("会合点");
  });
  it("maps 401 and revocation to the reconnect sentence", () => {
    expect(humanizeTransport({ code: "401" }, HOST).message).toBe(`401: ${EXPIRED}`);
    expect(humanizeTransport({ message: "Unexpected server response: 401" }, HOST).message).toBe(`401: ${EXPIRED}`);
    expect(humanizeReject("token revoked").message).toBe(`4003: ${EXPIRED}`);
    expect(humanizeReject("bad token").message).toBe(`401: ${EXPIRED}`);
    expect(humanizeReject("jwt expired").message).toBe(`401: ${EXPIRED}`);
    expect(humanizeReject("malformed jwt").message).toBe(`401: ${EXPIRED}`);
    expect(humanizeClose(4003).message).toBe(`4003: ${EXPIRED}`);
  });
  it("maps replacement, pairing, and version mismatch without remote prose", () => {
    expect(humanizeClose(4000).message).toBe(`4000: ${REPLACED}`);
    expect(humanizeReject("replaced by a newer agent for this user").message).toBe(`4000: ${REPLACED}`);
    expect(humanizeReject("pairing-expired").message).toBe("expired: 确认码已过期，请重新获取。");
    expect(humanizeReject("pairing-denied").message).toBe("denied: 确认码已被拒绝，请重新获取。");
    const mismatch = humanizeReject("codex version mismatch: secret-build");
    expect(mismatch.message).toContain("配套");
    expect(mismatch.message).not.toContain("secret-build");
  });
  it("does not echo an unknown reject reason", () => {
    const info = rejectionInfo("untrusted fixture-secret");
    expect(JSON.stringify(info)).not.toContain("fixture-secret");
    expect(info.reason).toBe("relay-rejected");
    expect(info.message).not.toContain("untrusted");
  });
});
