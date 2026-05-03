How to work with this peer:
- Treat it as an async worker/subagent.
- Do not poll it with peer_list, peer_history, or repeated peer_ask status checks.
- Continue your own work or wait passively.
- The peer will send a follow-up into the main context when it is done, blocked, or failed.
- Only contact the peer if the user explicitly asks, or if the peer asks for input.
