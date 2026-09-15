const { stripTypeScriptTypes } = require("node:module");
const { writeFileSync, mkdirSync, readFileSync } = require("node:fs");
const { join, dirname } = require("node:path");

// Amaro's stripOnly mode: erase TS type syntax, leave runtime code byte-identical.
// Throws on enums/namespaces/untyped-decorators (what ErasableSyntaxOnly bans).
const outDir = join(__dirname, "..", "dist");
mkdirSync(outDir, { recursive: true });

// Both bins are static shims into dist (bin/horizon.js → dist/cli.js,
// bin/horizon-inject.js → dist/inject.js), so the committed bins are the
// shipped bins — nothing here rewrites the bins or their imports in place.
for (const rel of ["cli.ts", "inject.ts", "store.ts", "texts.ts", "wiring.ts", "index.ts", "adapters/support.ts", "adapters/dsh.ts", "adapters/opencode.ts", "adapters/pi.ts"]) {
  const src = readFileSync(join(__dirname, "..", "src", rel), "utf8");
  const js = stripTypeScriptTypes(src, { mode: "strip", sourceMap: false })
    .replaceAll('"./store.ts"', '"./store.js"')
    .replaceAll('"./cli.ts"', '"./cli.js"') // inject.ts imports cliVersion from the cli module
    .replaceAll('"./texts.ts"', '"./texts.js"')
    .replaceAll('"./wiring.ts"', '"./wiring.js"') // cli.ts dispatches doctor/install from the wiring module
    .replaceAll('"./support.ts"', '"./support.js"'); // the adapters' shared spawn policy
  const target = join(outDir, rel.replace(/\.ts$/, ".js"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, js);
  console.log(`dist/${rel.replace(/\.ts$/, ".js")} ${js.length}B`);
}
