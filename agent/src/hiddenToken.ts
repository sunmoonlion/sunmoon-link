import type { ReadStream, WriteStream } from "node:tty";

// This is credential entry, not a permission-approval substitute. Only a local
// terminal can enter it; the token is never echoed, put in argv or logged.
export async function readHiddenToken(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
  timeoutMs = 120_000,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("令牌隐藏输入需要本机交互终端，不能通过管道输入。");
  }
  const raw = input.isRaw, flowing = input.readableFlowing;
  return new Promise((resolve, reject) => {
    let value = "", finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off("data", data); input.off("end", closed); input.off("error", closed);
      process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
      try { input.setRawMode(raw); } catch { error = "无法恢复终端状态，初始化已停止。"; }
      if (flowing !== true) input.pause();
      output.write("\n");
      const token = value; value = "";
      if (error) reject(new Error(error)); else resolve(token);
    };
    const closed = () => finish("终端已关闭，未保存令牌。");
    const interrupted = () => finish("已取消令牌输入，未保存配置。");
    const data = (chunk: Buffer | string) => {
      const text = chunk.toString();
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === "\r" || c === "\n") {
          if (!/^[\r\n]*$/.test(text.slice(i)) || value.length < 16) finish("令牌为空、过短或包含多行，初始化已停止。");
          else finish();
          return;
        }
        if (c === "\u0003" || c === "\u0004" || c === "\u001b") { interrupted(); return; }
        if (c === "\b" || c === "\u007f") { value = value.slice(0, -1); continue; }
        if (c === "\u0015") { value = ""; continue; }
        if (!/^[A-Za-z0-9._~-]$/.test(c) || value.length >= 8192) {
          finish("令牌含无效字符或过长，初始化已停止。"); return;
        }
        value += c;
      }
    };
    const timer = setTimeout(() => finish("令牌输入超时，未保存配置。"), timeoutMs);
    timer.unref();
    try { input.setRawMode(true); }
    catch { finish("无法启用隐藏输入，初始化已停止。"); return; }
    input.on("data", data); input.once("end", closed); input.once("error", closed);
    process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
    output.write("粘贴网页给本人的令牌后按回车（不回显；Ctrl+C 取消）：");
    input.resume();
  });
}
