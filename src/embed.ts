/**
 * Semantic search: the embedder port, the packing, and the cosine.
 *
 * Everything here is OPTIONAL and best-effort by construction. If no embedder
 * is bound, or it is down, or it returns an unusable shape, the node is still
 * written and text search still works — it just says so. A memory system that
 * refuses to remember because a side-car is unreachable has its priorities
 * backwards.
 *
 * Model choice is not a detail. This fleet measured bge-m3 against Apple's
 * NLContextualEmbedding on a labeled set: +47% English recall@50 and 3.4× on
 * Thai. MiniLM is 25× cheaper and scores the same on English, but is BLIND to
 * Thai — asked "สรุปงานที่ทำวันนี้" it returns noise. For a bilingual corpus the
 * choice is not quality in the abstract, it is whether half the corpus is
 * invisible. Hence a multilingual model, by default, on purpose.
 */

export interface Embedder {
  /** The SPACE, not just the model: a deployment identity. Vectors are only
   *  comparable within one of these. */
  readonly space: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class EmbedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

// The Workers-AI implementation that digger-node shipped here was deleted with
// the Cloudflare Worker target (trace-node PRD §2 Store row, §7). The port
// stays: a self-hosted node runs with `embedder: null`, and a local embedder
// (Ollama, say) is one object satisfying `Embedder`. An implementation must
// still check the vector WIDTH at embed time — a wrong-width vector corrupts
// the space silently and surfaces later as bad ranking — and throw
// `EmbedError` with a reason so callers can say why rather than "0 embedded".

// ── packing ──────────────────────────────────────────────────────────────────

/**
 * Float32 little-endian. dim * 4 bytes, and nothing else in the blob.
 *
 * Returns a Uint8Array, not the raw ArrayBuffer: SQLite drivers bind a typed
 * BYTE array and silently reject a bare ArrayBuffer. Because embedNode is
 * best-effort and swallows its errors, that rejection surfaced as "0 embedded"
 * with no message anywhere — measured here, 2026-09-03.
 */
export function packVector(vector: number[]): Uint8Array {
  const floats = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) floats[i] = Number.isFinite(vector[i]) ? vector[i] : 0;
  return new Uint8Array(floats.buffer);
}

/**
 * Read a stored vector back.
 *
 * Three input shapes, because the drivers disagree and only one of the
 * disagreements announces itself:
 *
 *   Uint8Array  — what bun:sqlite hands back.
 *   number[]    — what D1 hands back. A plain JS array of BYTE values.
 *   ArrayBuffer — the raw case.
 *
 * The number[] case is the dangerous one and it was live in production for one
 * deploy. `new Float32Array(someNumberArray)` does not reinterpret those bytes;
 * it COPIES each byte value as a float, producing a 4096-element vector of
 * small integers instead of the 1024 floats that were written. Nothing throws.
 * Cosine against a real query vector then returns ~0.00, which reads exactly
 * like "nothing in this corpus is related" — a wrong answer wearing the costume
 * of a right one. Measured on production 2026-09-03: every semantic score sat
 * between -0.03 and +0.01 until this branch existed.
 */
export function unpackVector(blob: ArrayBuffer | Uint8Array | number[]): Float32Array {
  if (Array.isArray(blob)) {
    return new Float32Array(new Uint8Array(blob).buffer);
  }
  const buffer =
    blob instanceof Uint8Array
      ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)
      : blob;
  return new Float32Array(buffer);
}

/**
 * Cosine similarity, normalising both sides.
 *
 * Not assuming unit vectors even though bge-m3 emits them: an assumption that
 * costs one sqrt and silently ranks wrong if a future embedder does not hold it.
 */
export function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** The exact text that gets embedded — title and body, one shape, always. */
export const embedText = (title: string, body: string): string =>
  `${title}\n\n${body}`.slice(0, 4000).trim();

/** sha-256 of the embedded text, so a stale vector is detectable, not guessed. */
export async function textHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
