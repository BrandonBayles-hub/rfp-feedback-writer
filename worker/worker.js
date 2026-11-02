const PATH = "implementation-prototype/fortiva-residential/feedback.json";
const REPO = "entrata/product-prototypes";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-rfp-feedback",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "cache-control": "no-store",
    },
  });
}

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

function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function decode(content) {
  const bin = atob(String(content).replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function readFile(token) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "rfp-feedback-log",
    },
  });
  if (response.status === 404) return { entries: [], sha: undefined };
  if (!response.ok) throw new Error("read failed");
  const payload = await response.json();
  let entries = [];
  try {
    const parsed = JSON.parse(decode(payload.content || ""));
    if (Array.isArray(parsed)) entries = parsed.map(clean).filter(Boolean);
  } catch {
    entries = [];
  }
  return { entries, sha: payload.sha };
}

async function writeFile(token, entries, sha) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "rfp-feedback-log",
    },
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
    let added = null;
    if (change.op === "add") {
      const known = byId.has(change.entry.id) || current.entries.some((entry) => sameNote(entry, change.entry));
      if (known) return { entries: current.entries, added: null };
      byId.set(change.entry.id, change.entry);
      added = change.entry;
    }
    if (change.op === "delete") byId.delete(change.id);
    const next = [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
    const wrote = await writeFile(token, next, current.sha);
    if (wrote) return { entries: next, added };
  }
  throw new Error("write failed");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });
    if (request.headers.get("x-rfp-feedback") !== env.GATE) return json({ error: "unauthorized" }, 401);
    if (!env.GITHUB_TOKEN) return json({ error: "unavailable" }, 503);
    try {
      if (request.method === "GET") {
        const current = await readFile(env.GITHUB_TOKEN);
        return json(current.entries);
      }
      if (request.method !== "POST") return json({ error: "method" }, 405);
      const body = await request.json();
      if (body.op === "add") {
        const entry = clean(body.entry);
        if (!entry) return json({ error: "invalid" }, 400);
        const result = await update(env.GITHUB_TOKEN, { op: "add", entry });
        return json(result.entries);
      }
      if (body.op === "delete" && typeof body.id === "string" && body.id.trim()) {
        return json((await update(env.GITHUB_TOKEN, { op: "delete", id: body.id.trim() })).entries);
      }
      return json({ error: "invalid" }, 400);
    } catch {
      return json({ error: "save failed" }, 502);
    }
  },
};
