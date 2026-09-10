// Core library entry (D1, exports["."]): the two locked section-10 strings
// and the render function, plus what the bins share. Adapters import from
// here in tests; composition itself is single-sourced in horizon-inject.
export { HORIZON_BLOCK_TEMPLATE, NUDGE_TEXT, horizonBlock, aboutPrefix } from "./texts.ts";
export { STORE_VERSION, MAX_GAPS, MAX_TEXT_POINTS } from "./store.ts";
