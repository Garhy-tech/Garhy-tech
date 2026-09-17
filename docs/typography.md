# GARHY Engineering OS Typography Contract

The public Engineering OS uses a strict two-family model:

- UI / content: Inter -> Segoe UI Variable -> Segoe UI -> Roboto -> Helvetica -> Arial -> sans-serif.
- Technical / machine data: Cascadia Code -> SFMono -> Consolas -> Liberation Mono -> Menlo -> monospace.

The visual scale is tokenized in `docs/styles.css` and intentionally limits text to a small set of sizes: 12, 13, 15, 17, 20 and 28px-equivalent steps plus one responsive display size.

Monospace is reserved for navigation tokens, telemetry labels, machine metadata and the console. Human-readable prose and headings use the UI stack.

This prevents arbitrary per-component font choices and keeps the public engineering surface consistent across desktop and mobile.
