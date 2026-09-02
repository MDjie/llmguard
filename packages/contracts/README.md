# GuardLLM Contracts

The canonical Guard v1 model is `model/guard-v1.schema.json`. Generated TypeScript,
Java, Python, OpenAPI and Protobuf files are committed so each consumer builds
without running a language-specific generator.

Run `pnpm contracts:generate` after a backward-compatible source change. CI runs
`pnpm contracts:check` and rejects generated drift, removed definitions or fields,
new required fields, changed field schemas and closed-enum changes.

Do not edit generated files. A breaking change requires a new major contract
directory and an explicit migration; never accept a breaking edit into the v1
baseline.
