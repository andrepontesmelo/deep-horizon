// horizon-line opencode adapter (stub).
//
// Ships DEGRADED per the packaging decision D4 and research/10 Part 2: no
// close hook exists at all (dispose receives no arguments), so opencode
// sessions write no session records. Implemented by the opencode adapter
// card; the stub exists so the D1 package shape (exports["./opencode"])
// resolves from day one.
export function apply(ctx) {
  return {};
}
