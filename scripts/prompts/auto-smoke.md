You are running an automated runtime smoke test for the local pi-ca-leash checkout.

Scope rules:
- Test only the runtime-backed extension tools.
- Do not invent results. Only mark a step PASS if the tool result actually supports it.
- Keep going after a failure when the next step is still safe.
- Cleanup is mandatory: stop the named peer and teammate before you finish.

Run metadata:
- Run id: __RUN_ID__
- Peer name: __PEER_NAME__
- Teammate name: __TEAM_NAME__
- Expected peer reply: `peer-ok __RUN_ID__`
- Expected subagent reply: `subagent-ok __RUN_ID__`
- Expected team message reply: `team-ok __RUN_ID__`

Required tool checklist:
1. Call `peer_start` with the exact peer name `__PEER_NAME__` and a prompt telling that peer to stay brief and, when directly asked later, reply with exactly `peer-ok __RUN_ID__`.
2. Call `peer_list` and confirm the named peer appears.
3. If the peer is still `starting` or `busy`, you may check `peer_list` a few more times until it is ready. Keep that bounded and brief.
4. Call `peer_ask` for `__PEER_NAME__` and ask for exactly `peer-ok __RUN_ID__`. Verify the returned reply contains that exact string.
5. Call `peer_history` for `__PEER_NAME__` with a small limit and confirm history is readable.
6. Call `peer_stop` for `__PEER_NAME__`.
7. Call `subagent_run` synchronously with a task that must reply with exactly `subagent-ok __RUN_ID__`. Capture the returned `runId`.
8. Call `subagent_list` and confirm the run appears.
9. Call `subagent_status` with the captured `runId` and confirm it completed.
10. Call `team_spawn` with the exact teammate name `__TEAM_NAME__` and a prompt telling that teammate to stay brief and, when directly messaged later, reply with exactly `team-ok __RUN_ID__`.
11. Call `team_list` and confirm the named teammate appears.
12. Call `team_task` for `__TEAM_NAME__` with a short title and concrete details.
13. Call `team_message` for `__TEAM_NAME__` and ask for exactly `team-ok __RUN_ID__`. Verify the returned reply contains that exact string.
14. Call `team_stop` for `__TEAM_NAME__`.

Output requirements:
- Return a Markdown checklist.
- One bullet per required step with `PASS` or `FAIL` and one short evidence note.
- Add a short `Notes` section for environment-dependent issues.
- Final line must be exactly `SMOKE_OK` if every required step passed.
- Otherwise final line must be exactly `SMOKE_FAIL`.
