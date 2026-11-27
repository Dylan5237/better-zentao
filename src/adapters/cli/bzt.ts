#!/usr/bin/env node
import { homedir } from "node:os";
import { runCli } from "./run-cli.ts";

const shutdownHooks: Array<() => Promise<void> | void> = [];
let shuttingDown = false;
function handleSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.allSettled(shutdownHooks.map((hook) => hook())).finally(() => {
    process.exit(0);
  });
}
process.on("SIGINT", handleSignal);
process.on("SIGTERM", handleSignal);

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    homeDir: homedir(),
    clock: () => Date.now(),
    nodeVersion: process.versions.node,
    onShutdown: (hook) => {
      shutdownHooks.push(hook);
    },
  });
} catch {
  process.stderr.write("bzt 启动失败。\n");
  process.exitCode = 1;
}
