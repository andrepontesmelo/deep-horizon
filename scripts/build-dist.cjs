const { stripTypeScriptTypes } = require("node:module");
const { writeFileSync, mkdirSync, readFileSync } = require("node:fs");
const { join, dirname } = require("node:path");

// Amaro's stripOnly mode: erase TS type syntax, leave runtime code byte-identical.
// Throws on enums/namespaces/untyped-decorators (what ErasableSyntaxOnly bans).
const outDir = join(__dirname, "..", "dist");
mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const rel of ["cli.ts", "store.ts", "texts.ts", "index.ts", "adapters/dsh.ts", "adapters/opencode.ts", "adapters/pi.ts"]) {
  const src = readFileSync(join(__dirname, "..", "src", rel), "utf8");
  const js = stripTypeScriptTypes(src, { mode: "strip", sourceMap: false })
    .replaceAll('"./store.ts"', '"./store.js"')
    .replaceAll('"../store.ts"', '"../store.js"') // adapters import the store resolver from src/adapters/
    .replaceAll('"./texts.ts"', '"./texts.js"');
  const target = join(outDir, rel.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, js);
  console.log(`dist/${rel.replace(/\.ts$/, ".js")} ${js.length}B`);
}

const bins = {
  "bin/horizon.js": [["../src/cli.ts", "../dist/cli.js"]],
  "bin/horizon-inject.js": [["../src/store.ts", "../dist/store.js"], ["../src/texts.ts", "../dist/texts.js"]],
};
for (const [bin, pairs] of Object.entries(bins)) {
  const p = join(__dirname, "..", bin);
  let s = readFileSync(p, "utf8");
  for (const [from, to] of pairs) {
    if (s.includes(to)) continue; // already rewritten (idempotent)
    if (!s.includes(from)) { console.error(`MISS ${bin}: neither ${from} nor ${to} present`); failures++; continue; }
    s = s.replace(from, to);
  }
  writeFileSync(p, s);
}
console.log(failures === 0 ? "bins rewritten" : "BIN REWRITE FAILURES");
process.exit(failures ? 1 : 0);
