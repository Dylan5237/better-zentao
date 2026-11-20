import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const repoDir = fileURLToPath(new URL("../../", import.meta.url));

function launch(entry, args, settings) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("ZENTAO_")));
  return spawn(process.execPath, [entry, ...args], {
    cwd: repoDir, env: { ...env, ...settings }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
}

export function runCli(args, env, input = "") {
  return new Promise((resolve, reject) => {
    const child = launch("dist/adapters/cli.js", args, env);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal) reject(new Error("CLI 子进程被信号终止 " + signal));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export function mcpProcess(env) {
  const child = launch("dist/adapters/mcp-stdio.js", [], env);
  const pending = new Map();
  const stdout = [];
  let stderr = "";
  let sequence = 0;
  let fault;
  function fail(error) {
    fault = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  }
  const closed = new Promise(resolve => child.on("close", resolve));
  child.on("error", fail);
  child.on("exit", code => {
    if (pending.size) fail(new Error("MCP 子进程提前退出 " + code));
  });
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
    stdout.push(line);
    let message;
    try {
      message = JSON.parse(line);
      if (message.jsonrpc !== "2.0") throw new Error();
    } catch {
      fail(new Error("MCP stdout 出现非 JSON-RPC 内容"));
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error("JSON-RPC 错误 " + message.error.code));
      else waiter.resolve(message.result);
    }
  });
  function send(message) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (fault) { reject(fault); return; }
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error("MCP 请求超时 " + method));
      }, 10_000);
      pending.set(id, {
        resolve(value) { clearTimeout(timeout); resolve(value); },
        reject(error) { clearTimeout(timeout); reject(error); },
      });
      send({ id, method, params });
    });
  }
  return {
    async initialize() {
      const result = await request("initialize", {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "better-zentao-smoke", version: "1" },
      });
      send({ method: "notifications/initialized" });
      return result;
    },
    list: () => request("tools/list", {}),
    call: (name, input = {}) => request("tools/call", { name, arguments: input }),
    get stderr() { return stderr; },
    get stdout() { if (fault) throw fault; return [...stdout]; },
    async close() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 2_000);
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}

export function toolData(output) {
  if (!output?.content?.[0]?.text) throw new Error("MCP 没有返回结构化内容");
  const data = JSON.parse(output.content[0].text);
  return { data, structured: output.structuredContent, isError: output.isError === true };
}
