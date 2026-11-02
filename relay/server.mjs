import http from "node:http";

const FILE_PATH = "implementation-prototype/fortiva-residential/feedback.json";
const REPO = "entrata/product-prototypes";

function clean(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.scope !== "general" && entry.scope !== "row") return null;
  for (const key of ["id", "name", "at", "text"]) {
    if (typeof entry[key] !== "string" || !entry[key].trim()) return null;
  }
  if (entry.topic != null && typeof entry.topic !== "string") return null;
  const cleaned = {
    id: entry.id.trim().slice(0, 80),
    scope: entry.scope,
    name: entry.name.trim().slice(0, 120),
    at: entry.at.trim().slice(0, 40),
    text: entry.text.trim().slice(0, 8000),
  };
  if (typeof entry.topic === "string" && entry.topic.trim()) cleaned.topic = entry.topic.trim().slice(0, 200);
  return cleaned;
}

async function github(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "rfp-feedback-relay",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  return response;
}

function encode(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

async function readFile(token) {
  const response = await github(token, `/repos/${REPO}/contents/${FILE_PATH}`);
  if (response.status === 404) return { entries: [], sha: undefined };
  if (!response.ok) throw new Error("read failed");
  const payload = await response.json();
  let entries = [];
  try {
    const parsed = JSON.parse(Buffer.from(payload.content || "", "base64").toString("utf8"));
    if (Array.isArray(parsed)) entries = parsed.map(clean).filter(Boolean);
  } catch {
    entries = [];
  }
  return { entries, sha: payload.sha };
}

async function writeFile(token, entries, sha) {
  const response = await github(token, `/repos/${REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    body: JSON.stringify({
      message: "chore: record RFP feedback",
      content: encode(`${JSON.stringify(entries, null, 2)}\n`),
      sha,
      branch: "main",
    }),
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error("write failed");
  return true;
}

function sameNote(a, b) {
  return a.scope === b.scope && (a.topic || "") === (b.topic || "") && a.text === b.text;
}

async function update(token, change) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readFile(token);
    const byId = new Map(current.entries.map((entry) => [entry.id, entry]));
    if (change.op === "add") {
      const known = byId.has(change.entry.id) || current.entries.some((entry) => sameNote(entry, change.entry));
      if (known) return current.entries;
      byId.set(change.entry.id, change.entry);
    }
    if (change.op === "delete") byId.delete(change.id);
    const next = [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
    if (await writeFile(token, next, current.sha)) return next;
  }
  throw new Error("write failed");
}

export function startRelay(port, token, gate) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type, x-rfp-feedback",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };
    try {
      if (req.method === "OPTIONS") return send(200, { ok: true });
      if (req.headers["x-rfp-feedback"] !== gate) return send(401, { error: "unauthorized" });
      if (!token) return send(503, { error: "unavailable" });
      if (req.method === "GET") return send(200, (await readFile(token)).entries);
      if (req.method !== "POST") return send(405, { error: "method" });
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body.op === "add") {
        const entry = clean(body.entry);
        if (!entry) return send(400, { error: "invalid" });
        return send(200, await update(token, { op: "add", entry }));
      }
      if (body.op === "delete" && typeof body.id === "string" && body.id.trim()) {
        return send(200, await update(token, { op: "delete", id: body.id.trim() }));
      }
      return send(400, { error: "invalid" });
    } catch {
      send(502, { error: "save failed" });
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
