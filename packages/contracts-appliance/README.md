# GuardLLM Appliance Contracts

`model/appliance-v1.schema.json` is the canonical Version B boundary between network data-plane,
inspection, device and evidence services. Generated TypeScript, Java, Python, Go and Protobuf
artifacts are committed so consumers do not need a language-specific generator during builds.

Run `pnpm appliance:contracts:generate` after a backward-compatible source change. CI uses
`pnpm appliance:contracts:check` to reject generated drift and breaking changes.

Guard v1 remains the authoritative AI decision contract. Appliance v1 adds network flow, frame,
capability, health, enforcement and receipt context without changing Guard v1.

Do not edit generated files. A breaking change requires a new major contract and an explicit
migration plan.
