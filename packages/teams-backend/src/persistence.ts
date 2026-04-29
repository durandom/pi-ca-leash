import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TeamTask, TeammateRecord } from "./types.js";

export function defaultTeamsDir(): string {
  return resolve(process.cwd(), ".teams-backend");
}

export async function writeTeammate(storageDir: string, teammate: TeammateRecord): Promise<void> {
  const file = join(storageDir, "teammates", `${teammate.name}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(teammate, null, 2)}\n`, "utf8");
}

export async function readTeammate(storageDir: string, name: string): Promise<TeammateRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(storageDir, "teammates", `${name}.json`), "utf8")) as TeammateRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function listTeammates(storageDir: string): Promise<TeammateRecord[]> {
  try {
    const dir = join(storageDir, "teammates");
    const files = await readdir(dir);
    const items = await Promise.all(files.map((file) => readTeammate(storageDir, file.replace(/\.json$/, ""))));
    return items.filter((value): value is TeammateRecord => Boolean(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function writeTask(storageDir: string, task: TeamTask): Promise<void> {
  const file = join(storageDir, "tasks", `${task.taskId}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, "utf8");
}

export async function readTask(storageDir: string, taskId: string): Promise<TeamTask | undefined> {
  try {
    return JSON.parse(await readFile(join(storageDir, "tasks", `${taskId}.json`), "utf8")) as TeamTask;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function listTasks(storageDir: string): Promise<TeamTask[]> {
  try {
    const dir = join(storageDir, "tasks");
    const files = await readdir(dir);
    const items = await Promise.all(files.map((file) => readTask(storageDir, file.replace(/\.json$/, ""))));
    return items.filter((value): value is TeamTask => Boolean(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
