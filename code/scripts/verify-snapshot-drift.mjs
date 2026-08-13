import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const chapterNumbers = [17, 18, 19, 20];
const sharedFiles = [
  "src/features/work-stealing.ts",
  "tests/ch17-work-stealing.test.ts",
];

const failures = [];
for (const relativePath of sharedFiles) {
  const baselinePath = chapterPath(chapterNumbers[1], relativePath);
  const baseline = await readFile(baselinePath, "utf8");
  for (const chapterNumber of chapterNumbers.slice(2)) {
    const candidatePath = chapterPath(chapterNumber, relativePath);
    const candidate = await readFile(candidatePath, "utf8");
    if (candidate !== baseline) {
      failures.push(
        `ch${chapterNumber} ${relativePath} differs from ch${chapterNumbers[1]} after P18 introduction`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Snapshot drift detected:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("P18-P20 shared work-stealing snapshots are synchronized.");
}

function chapterPath(chapterNumber, relativePath) {
  return join(projectRoot, "chapters", `ch${String(chapterNumber).padStart(2, "0")}`, relativePath);
}
