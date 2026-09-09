// horizon-line pi adapter (stub).
//
// Per the packaging decision D3/D4 build order: implemented after the DSH
// reference adapter by the pi adapter card (session_start shells out and
// stashes, before_agent_start returns the message gated on the first
// prompt; session_shutdown closes). The stub exists so the D1 package shape
// (exports["./pi"]) resolves from day one.
export function apply(ctx) {
  return {};
}
