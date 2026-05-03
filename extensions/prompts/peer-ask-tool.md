Ask an existing peer for a status update, follow-up, or delegated result. Optionally pass model to switch the peer model persistently.
- Use `peer_ask` only with an existing peer name.
- Prefer concise direct asks because the peer reply is returned into the current turn.
- Call `runtime_models` first when you need the supported model ids for a driver.
- Pass `model` when you want this peer to switch models for this and future asks.
