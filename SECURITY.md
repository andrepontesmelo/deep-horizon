# Security Policy

## Scope

deep-horizon is a CLI + adapter set: it maintains a deterministic horizon
store (`.horizon/`) and wires harness hooks that inject it at session start.
It holds no credentials — API keys live in each harness's own profile/config,
not here — and nothing leaves the machine: injection is local text composition
through the `horizon-inject` bin, not a network call.

`horizon install` writes to global harness configs (`~/.zcode/cli/config.json`,
`~/.hermes/config.yaml` plus the plugins dir). Every write is parse → merge →
validate → timestamped backup → atomic; a config that does not parse, or a
shape install does not recognize, is refused loudly rather than blind-written.

## Supported versions

Fixes target the `main` branch HEAD and the latest published npm version;
release tags lag behind `main`, so name the commit or npm version in reports.

## Reporting a vulnerability

Email the owner via the contact on the GitHub profile (andrepontesmelo) rather
than opening a public issue. Include: affected version/commit, the harness and
config involved (redact anything private), and expected vs actual behavior. You
will get an acknowledgement within 7 days and a fix or a documented mitigation
for anything confirmed.

## What is NOT a vulnerability

- A harness running the installed hooks and injecting the horizon into
  sessions — that is the product's stated purpose. Audit unfamiliar hook
  configs before installing them.
- `horizon install` refusing to write an unrecognized config shape, or
  `horizon doctor` reporting FAIL lines — those are the designed safety
  surface, not a denial of service.
- Hooks failing open (a missing bin or an error injects nothing) — by design:
  injection must never block a session, so the failure mode is silence.
