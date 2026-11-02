import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startRelay } from "./server.mjs";

const token = process.env.FEEDBACK_TOKEN;
const gate = process.env.FEEDBACK_GATE;
const API_FILE = "implementation-prototype/fortiva-residential/feedback-api.json";
const HOLD_MS = 5 * 60 * 60 * 1000;
const HANDOFF_MS = 30 * 60 * 1000;

function log(message) {
  console.log(`${new Date().toISOString()} ${message}`);
}

async function github(pathname, options = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "rfp-feedback-relay",
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!response.ok) throw new Error(`github ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function readPointer() {
  const payload = await github(`/repos/entrata/product-prototypes/contents/${API_FILE}`);
  const parsed = JSON.parse(Buffer.from(payload.content || "", "base64").toString("utf8"));
  return { ...parsed, sha: payload.sha };
}

async function writePointer(url, expires, sha) {
  await github(`/repos/entrata/product-prototypes/contents/${API_FILE}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "chore: refresh RFP feedback writer",
      content: Buffer.from(`${JSON.stringify({ url, expires, kind: "relay" }, null, 2)}\n`).toString("base64"),
      sha,
      branch: "main",
    }),
  });
}

async function answers(url) {
  try {
    const response = await fetch(url, { headers: { "x-rfp-feedback": gate, "user-agent": "rfp-feedback-relay" } });
    if (!response.ok) return false;
    const body = await response.json();
    return Array.isArray(body);
  } catch {
    return false;
  }
}

async function cloudflaredPath() {
  const bin = path.join(os.tmpdir(), "cloudflared");
  if (fs.existsSync(bin)) return bin;
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const name = platform === "darwin" ? `cloudflared-${platform}-${arch}.tgz` : `cloudflared-${platform}-${arch}`;
  const download = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`);
  if (!download.ok) throw new Error("cloudflared download failed");
  const bytes = Buffer.from(await download.arrayBuffer());
  if (name.endsWith(".tgz")) {
    const tarPath = `${bin}.tgz`;
    fs.writeFileSync(tarPath, bytes);
    await new Promise((resolve, reject) => {
      const child = spawn("tar", ["-xzf", tarPath, "-C", os.tmpdir()], { stdio: "ignore" });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("tar failed"))));
    });
  } else {
    fs.writeFileSync(bin, bytes, { mode: 0o755 });
  }
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function openTunnel(port) {
  const bin = await cloudflaredPath();
  const logPath = path.join(os.tmpdir(), "rfp-relay-tunnel.log");
  const output = fs.createWriteStream(logPath);
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  const started = Date.now();
  while (Date.now() - started < 40000) {
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) return { url: match[0], child };
    if (child.exitCode != null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill("SIGTERM");
  throw new Error("tunnel did not open");
}

async function main() {
  if (!token || !gate) throw new Error("missing relay credentials");
  const current = await readPointer().catch(() => null);
  const expiresAt = current?.expires ? Date.parse(current.expires) : 0;
  if (current?.kind === "relay" && current.url && expiresAt > Date.now() + 25 * 60 * 1000 && await answers(current.url)) {
    log("relay already up");
    return;
  }
  const port = 8787;
  const server = await startRelay(port, token, gate);
  const tunnel = await openTunnel(port);
  let healthy = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await answers(tunnel.url)) {
      healthy = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!healthy) throw new Error("relay did not answer");
  const pointer = await readPointer();
  const expires = new Date(Date.now() + HOLD_MS + HANDOFF_MS).toISOString();
  await writePointer(tunnel.url, expires, pointer.sha);
  log("relay published");
  const stopAt = Date.now() + HOLD_MS;
  while (Date.now() < stopAt) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 60 * 1000, stopAt - Date.now())));
    if (!(await answers(tunnel.url))) throw new Error("relay stopped answering");
    log("relay healthy");
  }
  await github("/repos/BrandonBayles-hub/rfp-feedback-writer/actions/workflows/relay.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: "main" }),
  });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const next = await readPointer().catch(() => null);
    if (next?.url && next.url !== tunnel.url && await answers(next.url)) {
      log("handed off");
      server.close();
      tunnel.child.kill("SIGTERM");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15000));
  }
  throw new Error("handoff failed");
}

main().catch((error) => {
  log(error.message || "relay failed");
  process.exit(1);
});
