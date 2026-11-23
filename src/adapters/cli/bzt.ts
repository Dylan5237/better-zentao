#!/usr/bin/env node
import { homedir } from "node:os";
import { runCli } from "./run-cli.ts";

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    homeDir: homedir(),
    clock: () => Math.trunc(performance.timeOrigin + performance.now()),
    nodeVersion: process.versions.node,
  });
} catch {
  process.stderr.write("bzt 启动失败。\n");
  process.exitCode = 1;
}
