import { SqliteTaskStore } from "../../src/adapters/task-sqlite.js";

const workspace = process.argv.at(-2);
const owner = process.argv.at(-1);
if (workspace === undefined || owner === undefined) {
  throw new Error("workspace and owner are required");
}

const claim = await new SqliteTaskStore(workspace).claimNext(owner);
if (claim !== undefined) process.stdout.write(`${claim.task.id}\n`);
