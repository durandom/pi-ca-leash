Send input to a peer without waiting for the reply. Use this when the peer will report back asynchronously.
- Use `peer_send` instead of `peer_ask` when you do not need an immediate reply.
- Do not use it to poll for status; wait for automated peer updates.
- If the peer is busy, wait for its automated update before sending more input.
- Call `runtime_models` first when you need the supported model ids for a driver.
