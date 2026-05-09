#!/usr/bin/env node
// End-to-end test: spawn MCP server, send init + 6 tool calls, print results.
// Uses this repo as the cwd target (it is a git repo with commits and files).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const serverPath = join(root, "dist", "index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: root,
});

let buf = "";
const responses = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        const cb = responses.get(msg.id);
        if (cb) {
          responses.delete(msg.id);
          cb(msg);
        }
      }
    } catch {}
  }
});

child.stderr.on("data", (c) => process.stderr.write(`[stderr] ${c}`));

let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    responses.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    child.stdin.write(payload);
    setTimeout(() => {
      if (responses.has(id)) {
        responses.delete(id);
        reject(new Error(`timeout ${method}`));
      }
    }, 15000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function call(name, args = {}) {
  return rpc("tools/call", { name, arguments: { cwd: root, ...args } });
}

function ok(label, result, predicate) {
  const text = result?.content?.[0]?.text ?? "";
  const isErr = result?.isError;
  const head = text.length > 400 ? text.slice(0, 400) + "..." : text;
  const passes = !isErr && (predicate ? predicate(text) : true);
  console.log(`\n=== ${label} ${passes ? "[OK]" : "[FAIL]"} ===\n${head}`);
  return passes;
}

let pass = 0, fail = 0;
function tally(b) { b ? pass++ : fail++; }

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-test", version: "1.0" },
  });
  notify("notifications/initialized", {});

  const toolsList = await rpc("tools/list", {});
  console.log(`\n=== tools/list ===\n${toolsList.tools.map((t) => "- " + t.name).join("\n")}`);
  tally(toolsList.tools.length === 6);

  // who_touched on a known file
  tally(ok(
    "who_touched src/git.ts",
    await call("who_touched", { file: "src/git.ts" }),
    (t) => /HasanJahidul/.test(t) && /primary_owner/.test(t),
  ));

  // co_change on the same file (small repo, may have empty co_changed; OK)
  tally(ok(
    "co_change src/git.ts (low threshold)",
    await call("co_change", { file: "src/git.ts", threshold: 1 }),
    (t) => /total_commits_touching/.test(t),
  ));

  // branch_hygiene — single-branch repo returns []; OK if shape is right
  tally(ok(
    "branch_hygiene",
    await call("branch_hygiene", {}),
    (t) => /branches/.test(t) && /count/.test(t),
  ));

  // recent_work — defaults to current user, this repo has commits today
  tally(ok(
    "recent_work (default since)",
    await call("recent_work", {}),
    (t) => /commit_count/.test(t) && /commits/.test(t),
  ));

  // commit_context — get HEAD sha first via git, then call
  const { execFileSync } = await import("node:child_process");
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  tally(ok(
    `commit_context HEAD (${headSha.slice(0, 7)})`,
    await call("commit_context", { sha: headSha }),
    (t) => /files_changed/.test(t) && /insertions/.test(t),
  ));

  // introducing_pr — without GH_TOKEN, expect graceful pr=null
  tally(ok(
    `introducing_pr commit=HEAD (no token graceful)`,
    await call("introducing_pr", { commit: headSha }),
    (t) => /commit/.test(t) && /source/.test(t),
  ));

  // Negative: missing required arg
  const noFile = await call("who_touched", {});
  const negOk = noFile?.isError === true;
  console.log(`\n=== who_touched (no file, expect graceful error) ${negOk ? "[OK]" : "[FAIL]"} ===\n${(noFile?.content?.[0]?.text ?? "").slice(0, 200)}`);
  tally(negOk);

  console.log(`\n--- ${pass} passed, ${fail} failed ---`);
  child.kill("SIGTERM");
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  console.error("FATAL:", e);
  child.kill("SIGTERM");
  process.exit(1);
}
