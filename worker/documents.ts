// Customer-submitted documents (passport copies, licences, payment receipts) captured by an
// `upload` automation node, on web chat or WhatsApp.
//
// Storage: base64 in D1, split across chunk rows. D1 caps a single row at 2 MB and base64 inflates
// a file by ~33%, so a one-row-per-file design would fail on anything over ~1.5 MB — which is most
// scanned PDFs. Chunking keeps individual rows small and lets the same code hold a 5 MB document.
// R2 is the better home for this if volume grows; the read/write surface here is deliberately small
// (saveDocument / readDocument) so swapping the backend later touches only those two functions.

import type { DocumentSpec } from "./automation-graph";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Comfortably under D1's 2 MB row ceiling once base64 expansion is applied.
const CHUNK_BYTES = 700 * 1024;

export type StoredDocument = {
  id: string; docKey: string; docLabel: string;
  fileName: string; mimeType: string; sizeBytes: number;
  channel: string; createdAt: string;
};

let documentSchemaEnsured = false;

export async function ensureDocumentSchema(db: D1Database): Promise<void> {
  if (documentSchemaEnsured) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS document_uploads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      contact_key TEXT NOT NULL,
      automation_id TEXT NOT NULL DEFAULT '',
      node_id TEXT NOT NULL DEFAULT '',
      doc_key TEXT NOT NULL,
      doc_label TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      channel TEXT NOT NULL DEFAULT 'webchat',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS document_chunks (
      upload_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (upload_id, idx)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_document_uploads_contact ON document_uploads (workspace_id, contact_key)`),
  ]);
  documentSchemaEnsured = true;
}

// ── Real file-type detection ──
//
// The filename extension and the browser-supplied MIME type are both attacker-controlled, so
// neither can decide whether a file is what it claims. These signatures are read from the actual
// bytes. A format we cannot sniff is not offered as an accepted type at all.
export function sniffFileType(bytes: Uint8Array): { ext: string; mime: string } | null {
  const startsWith = (sig: number[], offset = 0) =>
    bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b);

  if (startsWith([0x25, 0x50, 0x44, 0x46])) return { ext: "pdf", mime: "application/pdf" };           // %PDF
  if (startsWith([0xff, 0xd8, 0xff])) return { ext: "jpg", mime: "image/jpeg" };
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", mime: "image/png" };
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return { ext: "webp", mime: "image/webp" };
  // ISO-BMFF box: ....ftypheic / ftypheix / ftypmif1
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return { ext: "heic", mime: "image/heic" };
  }
  return null;
}

export type ValidationResult = { ok: true; ext: string; mime: string } | { ok: false; error: string };

export function validateAgainstSpec(bytes: Uint8Array, spec: DocumentSpec): ValidationResult {
  const maxBytes = Math.min(spec.maxMb * 1024 * 1024, MAX_UPLOAD_BYTES);
  if (!bytes.length) return { ok: false, error: "That file appears to be empty." };
  if (bytes.length > maxBytes) {
    return { ok: false, error: `That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB. Please send a version under ${spec.maxMb} MB.` };
  }
  const sniffed = sniffFileType(bytes);
  if (!sniffed) return { ok: false, error: "We could not read that file. Please send a PDF or a photo." };
  // jpg/jpeg are the same bytes; treat the caller's spelling as equivalent.
  const accepted = spec.accept.map((a) => (a === "jpeg" ? "jpg" : a));
  if (!accepted.includes(sniffed.ext)) {
    return { ok: false, error: `That looks like a ${sniffed.ext.toUpperCase()} file. For ${spec.label} we need: ${accepted.join(", ").toUpperCase()}.` };
  }
  return { ok: true, ext: sniffed.ext, mime: sniffed.mime };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000; // chunked to avoid blowing the argument limit on large files
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export type SaveArgs = {
  workspaceId: string; contactKey: string; automationId: string; nodeId: string;
  docKey: string; docLabel: string; fileName: string; mimeType: string;
  channel: string; bytes: Uint8Array;
};

export async function saveDocument(db: D1Database, args: SaveArgs): Promise<string> {
  await ensureDocumentSchema(db);
  const id = crypto.randomUUID();

  // Re-uploading the same document replaces the previous attempt rather than piling up drafts —
  // the customer correcting a blurry photo should not leave the agent guessing which one counts.
  const prior = await db.prepare(
    `SELECT id FROM document_uploads WHERE workspace_id = ? AND contact_key = ? AND node_id = ? AND doc_key = ?`
  ).bind(args.workspaceId, args.contactKey, args.nodeId, args.docKey).all<{ id: string }>();
  for (const row of prior.results || []) {
    await db.prepare(`DELETE FROM document_chunks WHERE upload_id = ?`).bind(row.id).run();
    await db.prepare(`DELETE FROM document_uploads WHERE id = ?`).bind(row.id).run();
  }

  await db.prepare(
    `INSERT INTO document_uploads (id, workspace_id, contact_key, automation_id, node_id, doc_key, doc_label, file_name, mime_type, size_bytes, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, args.workspaceId, args.contactKey, args.automationId, args.nodeId, args.docKey, args.docLabel,
    args.fileName.slice(0, 200), args.mimeType, args.bytes.length, args.channel).run();

  for (let i = 0, idx = 0; i < args.bytes.length; i += CHUNK_BYTES, idx++) {
    const chunk = toBase64(args.bytes.subarray(i, i + CHUNK_BYTES));
    await db.prepare(`INSERT INTO document_chunks (upload_id, idx, data) VALUES (?, ?, ?)`).bind(id, idx, chunk).run();
  }
  return id;
}

export async function readDocument(db: D1Database, workspaceId: string, id: string): Promise<{ meta: StoredDocument; bytes: Uint8Array } | null> {
  await ensureDocumentSchema(db);
  const meta = await db.prepare(
    `SELECT id, doc_key, doc_label, file_name, mime_type, size_bytes, channel, created_at
     FROM document_uploads WHERE id = ? AND workspace_id = ?`
  ).bind(id, workspaceId).first<Record<string, string | number>>();
  if (!meta) return null;

  const chunks = await db.prepare(`SELECT data FROM document_chunks WHERE upload_id = ? ORDER BY idx ASC`)
    .bind(id).all<{ data: string }>();
  const parts = (chunks.results || []).map((r) => fromBase64(r.data));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { bytes.set(p, offset); offset += p.length; }

  return { meta: rowToDocument(meta), bytes };
}

function rowToDocument(r: Record<string, string | number>): StoredDocument {
  return {
    id: String(r.id), docKey: String(r.doc_key), docLabel: String(r.doc_label),
    fileName: String(r.file_name), mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes) || 0, channel: String(r.channel), createdAt: String(r.created_at),
  };
}

export async function listDocumentsForContact(db: D1Database, workspaceId: string, contactKey: string): Promise<StoredDocument[]> {
  await ensureDocumentSchema(db);
  const rows = await db.prepare(
    `SELECT id, doc_key, doc_label, file_name, mime_type, size_bytes, channel, created_at
     FROM document_uploads WHERE workspace_id = ? AND contact_key = ? ORDER BY created_at ASC`
  ).bind(workspaceId, contactKey).all<Record<string, string | number>>();
  return (rows.results || []).map(rowToDocument);
}

// Which doc_keys this contact has already supplied at a given node — the engine uses this to decide
// whether an upload step is satisfied or still waiting.
export async function receivedKeysAtNode(db: D1Database, workspaceId: string, contactKey: string, nodeId: string): Promise<Set<string>> {
  await ensureDocumentSchema(db);
  const rows = await db.prepare(
    `SELECT DISTINCT doc_key FROM document_uploads WHERE workspace_id = ? AND contact_key = ? AND node_id = ?`
  ).bind(workspaceId, contactKey, nodeId).all<{ doc_key: string }>();
  return new Set((rows.results || []).map((r) => r.doc_key));
}
