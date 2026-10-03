#!/usr/bin/env node
// The `jev` command: runs the TypeScript CLI through tsx, so `npx jev apply` works right after `npm install`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const r = spawnSync(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
