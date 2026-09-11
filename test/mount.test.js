import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The cordis mount row must name a subpath export, not the bare package name:
// a bare name resolves through the exports-map root, which exports only texts/
// store constants — no apply — so cordis mounts nothing, silently. The row is
// parsed out of the README and imported the way a host would resolve it.
test("77. the README's DSH mount row resolves through the exports map to a module exporting apply", async () => {
  const lines = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n");
  const dsh = lines.findIndex((l) => l.startsWith("### 1. DeepSeek Harness"));
  assert.notEqual(dsh, -1, "README.md lost its DSH section");
  const insert = lines.findIndex((l, i) => i > dsh && l.trim() === "- insert:");
  assert.notEqual(insert, -1, "README.md DSH section lost its - insert: mount row");
  const close = lines.findIndex((l, i) => i > insert && l.trim() === "```");
  assert.ok(close > insert, "mount row fence is unclosed");
  const row = lines.slice(insert, close).find((l) => /^\s*name:\s*\S+\s*$/.test(l));
  assert.ok(row, "mount row has no name: entry");
  const name = row.match(/^\s*name:\s*(\S+)\s*$/)[1];

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(name === pkg.name || name.startsWith(`${pkg.name}/`), `mount name ${name} points outside ${pkg.name}`);

  const mod = await import(import.meta.resolve(name));
  assert.equal(typeof mod.apply, "function", `${name} resolves to a module with no apply export — cordis would mount nothing`);
});
