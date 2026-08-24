import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

const ORGANIZED_ROOT = "organized";

// If ALLOWED_ROOTS is set (a list of absolute paths separated by path.delimiter),
// "folder" must be inside one of them. Unset keeps the demo's original behavior:
// accept any absolute folder.
const ALLOWED_ROOTS = (process.env.ALLOWED_ROOTS ?? "")
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));

function extensionOf(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return ext;
}

function isoDateOf(mtime: Date): string {
  return mtime.toISOString().slice(0, 10);
}

// true if `child` is `parent` itself or nested inside it once both are resolved.
function isInside(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// "folder" must be an explicit absolute path — relative paths are rejected instead of
// being resolved against the server process's cwd, since that cwd depends on how the
// MCP host launches the subprocess, not on anything the tool caller controls.
function resolveFolder(folder: string): string {
  if (!path.isAbsolute(folder)) {
    throw new Error(`"folder" must be an absolute path, got: "${folder}"`);
  }
  const resolved = path.resolve(folder);
  if (ALLOWED_ROOTS.length > 0 && !ALLOWED_ROOTS.some((allowed) => isInside(allowed, resolved))) {
    throw new Error(`"folder" (${resolved}) is outside ALLOWED_ROOTS`);
  }
  return resolved;
}

// "name" must be a plain file name — no path separators or ".." — so that
// path.join(root, name) can never point outside `root`.
function assertPlainFileName(name: string, field: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error(`"${field}" must be a plain file name, got: "${name}"`);
  }
}

// Validates and performs a single move, throwing on any violation — move_files
// catches this per-entry so one bad entry doesn't abort the rest of the batch.
async function moveOneFile(root: string, name: string, to_folder: string, dry_run: boolean | undefined): Promise<string> {
  assertPlainFileName(name, "name");

  const organizedRoot = path.join(root, ORGANIZED_ROOT);
  const sourcePath = path.resolve(root, name);
  const targetDir = path.resolve(organizedRoot, to_folder);
  const targetPath = path.join(targetDir, name);

  if (!isInside(root, sourcePath)) {
    throw new Error(`"name" escapes "${root}": resolved to "${sourcePath}"`);
  }
  if (!isInside(organizedRoot, targetPath)) {
    throw new Error(`"to_folder" escapes "${organizedRoot}": resolved to "${targetPath}"`);
  }

  const sourceStat = await fs.stat(sourcePath).catch(() => null);
  if (!sourceStat) {
    throw new Error(`Source not found: "${sourcePath}"`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`"name" is a folder, not a file — refusing to move it: "${sourcePath}"`);
  }

  const destinationExists = await fs
    .access(targetPath)
    .then(() => true)
    .catch(() => false);
  if (destinationExists) {
    throw new Error(`Destination already exists, refusing to overwrite: "${targetPath}"`);
  }

  if (dry_run) {
    return `Dry run: would move "${name}" to "${ORGANIZED_ROOT}/${to_folder}" inside "${root}".`;
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.rename(sourcePath, targetPath);
  return `Moved "${name}" to "${ORGANIZED_ROOT}/${to_folder}" inside "${root}".`;
}

const server = new McpServer({ name: "file-organizer", version: "1.0.0" });

server.registerTool(
  "list_files",
  {
    description:
      "Lists the files directly inside a folder (not recursive) — subfolders are excluded, not descended into. Includes each file's last-modified date (modified) so it can be sorted by year/month/day. Only reads file names and metadata, never file content.",
    inputSchema: z.object({
      folder: z.string().describe("Absolute path to the folder to organize, e.g. 'C:\\Users\\you\\Downloads'"),
    }),
  },
  async ({ folder }) => {
    const dirPath = resolveFolder(folder);
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const stat = await fs.stat(path.join(dirPath, entry.name));
          return {
            name: entry.name,
            extension: extensionOf(entry.name),
            modified: isoDateOf(stat.mtime),
          };
        }),
    );
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  },
);

server.registerTool(
  "move_files",
  {
    description:
      `Moves one or more files from the folder being organized into a destination nested under ${ORGANIZED_ROOT}/ inside that same folder — pass a single-entry "moves" array to move just one file. Every entry is validated and moved independently: only plain files directly inside that folder are valid targets (a "name" that resolves to a subfolder, e.g. ${ORGANIZED_ROOT}/ itself, is rejected instead of moving the whole directory tree), and a destination that already exists is never overwritten. to_folder can be a nested path, e.g. 'pdf/2026/07/14', to organize files by type and then by year/month/day. A failing entry does not stop the rest of the batch — check each entry's "ok" field in the result to see which ones failed and why. Set dry_run to preview every move without touching the filesystem.`,
    inputSchema: z.object({
      folder: z.string().describe("Absolute path to the folder being organized, e.g. 'C:\\Users\\you\\Downloads'"),
      moves: z
        .array(
          z.object({
            name: z.string().describe("Name of the file to move — a plain file name, not a path"),
            to_folder: z.string().describe(`Destination path under ${ORGANIZED_ROOT}/, e.g. 'pdf/2026/07/14'`),
          }),
        )
        .min(1)
        .describe("The files to move and where each one should go"),
      dry_run: z.boolean().optional().describe("If true, report what would happen without moving anything"),
    }),
  },
  async ({ folder, moves, dry_run }) => {
    const root = resolveFolder(folder);
    const results: Array<{ name: string; to_folder: string; ok: boolean; message?: string; error?: string }> = [];
    for (const { name, to_folder } of moves) {
      try {
        const message = await moveOneFile(root, name, to_folder, dry_run);
        results.push({ name, to_folder, ok: true, message });
      } catch (err) {
        results.push({ name, to_folder, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const movedCount = results.filter((r) => r.ok).length;
    const summary = `${movedCount}/${results.length} file(s) ${dry_run ? "would be moved" : "moved"} successfully.`;
    return { content: [{ type: "text", text: JSON.stringify({ summary, results }, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
