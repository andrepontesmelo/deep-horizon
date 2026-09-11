// Shared store seeder for the cli, inject, and adapter suites. Builds a valid
// store through the store module's public interface — the way `horizon init`
// plus one `horizon add` per text would — so no test ever hand-writes a
// gaps.json document and the store's write invariant cannot be deseeded by
// drift. ensureStoreDir creates the store at the exact directory given (no
// upward resolution, or nested seeds would land in an ancestor's store);
// afterwards addGap resolves it as the nearest store. Stamps come from
// utcNow(), ids are gap-1..gap-N in order, and the stored gaps are returned
// exactly as the store holds them.
import { addGap, ensureStoreDir, readGapsFile } from "../src/store.ts";

export function seed(dir, texts) {
  const m = ensureStoreDir(dir);
  if (m.code !== undefined) throw new Error(m.message);
  for (let i = 0; i < texts.length; i += 1) {
    const r = addGap(dir, {
      id: `gap-${i + 1}`,
      text: texts[i],
      harness: "test",
      sessionId: "seed",
      tty: false,
      origin: "human",
    });
    if (r) throw new Error(r.message);
  }
  const g = readGapsFile(m.dir);
  if (!g.ok) throw new Error(g.message);
  return g.data.gaps;
}
