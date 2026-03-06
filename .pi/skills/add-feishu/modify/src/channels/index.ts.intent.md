# Intent: Add Feishu channel import

Add `import './feishu.js';` to the channel barrel file so the Feishu channel
self-registers at startup via `registerChannel(...)`.

## Invariants

- Keep existing channel imports intact.
- Append-only behavior; no unrelated reorder/logic changes.
- The barrel should remain a pure side-effect import file.
