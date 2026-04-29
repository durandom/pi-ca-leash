export { ClaudeCodeTeamsBackend } from "./backend.js";
export { defaultTeamsDir, writeTeammate, readTeammate, listTeammates, writeTask, readTask, listTasks } from "./persistence.js";
export { classifyTaskReply, formatTaskAssignment, mapState } from "./backend.js";
export type {
  SpawnTeammateInput,
  TeamMessageResult,
  TeamTask,
  TeamTaskState,
  TeamsBackendOptions,
  TeammateBackend,
  TeammateRecord,
  TeammateState,
} from "./types.js";
