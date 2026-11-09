# Local storage contract fixture

`contract-v1.json` is the shared compatibility fixture for the Node API and
Python worker storage ports. Both implementations apply these rules:

- Object keys are derived from an inspection UUID and, for processed outputs,
  a positive processing generation. Filenames and other user input are never
  part of a key.
- `put` streams bytes into storage and atomically replaces the complete object
  at the same key. A failed write leaves an existing object unchanged.
- `read` and `metadata` report a missing-object error for absent keys.
- `metadata` reports the stored byte count, and `exists` returns a boolean.
- `delete` is idempotent and removes empty object directories after cleanup.
- Absolute paths, traversal segments, and platform path separators are invalid
  object keys.

The fixture covers source video, normalized media, thumbnail, and prediction
artifact keys without prescribing their media encoding.
