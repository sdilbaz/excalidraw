// Stand-in for `open <url>` in the daemon tests: appends the URL to a file.
// Usage: node recordOpen.mjs <file> <url>
import { appendFileSync } from "node:fs";

appendFileSync(process.argv[2], `${process.argv[3]}\n`);
