import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

const ORGANIZED_ROOT = "organized";

// Bucket for files whose name carries no extension (e.g. "README", ".env"), so the
// default scheme below always yields a valid first path segment.
const NO_EXTENSION = "no-extension";

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

// Destination applied when the caller omits to_folder: <extension>/<year>/<month>/<day>.
// The date comes from isoDateOf(mtime) — the same value list_files reports as
// "modified" — so both tools always agree on which day a file belongs to.
function defaultToFolder(fileName: string, mtime: Date): string {
  const extension = extensionOf(fileName) || NO_EXTENSION;
  const [year, month, day] = isoDateOf(mtime).split("-");
  return `${extension}/${year}/${month}/${day}`;
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
  if (
    ALLOWED_ROOTS.length > 0 &&
    !ALLOWED_ROOTS.some((allowed) => isInside(allowed, resolved))
  ) {
    throw new Error(`"folder" (${resolved}) is outside ALLOWED_ROOTS`);
  }
  return resolved;
}

// "name" must be a plain file name — no path separators or ".." — so that
// path.join(root, name) can never point outside `root`.
function assertPlainFileName(name: string, field: string): void {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`"${field}" must be a plain file name, got: "${name}"`);
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function destinationExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (errorCodeOf(error) === "ENOENT") return false;
    throw error;
  }
}

// Validates and performs a single move, throwing on any violation — move_files
// catches this per-entry so one bad entry doesn't abort the rest of the batch.
async function moveOneFile(
  root: string,
  name: string,
  requestedToFolder: string | undefined,
  dry_run: boolean | undefined,
): Promise<{ to_folder: string; message: string }> {
  assertPlainFileName(name, "name");

  const organizedRoot = path.join(root, ORGANIZED_ROOT);
  const sourcePath = path.resolve(root, name);

  if (!isInside(root, sourcePath)) {
    throw new Error(`"name" escapes "${root}": resolved to "${sourcePath}"`);
  }

  const sourceStat = await fs.stat(sourcePath).catch((error: unknown) => {
    if (errorCodeOf(error) === "ENOENT") return null;
    throw error;
  });
  if (!sourceStat) {
    throw new Error(`Source not found: "${sourcePath}"`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(
      `"name" is a folder, not a file — refusing to move it: "${sourcePath}"`,
    );
  }

  // The default scheme needs the file's mtime, so it is resolved only after the
  // source is confirmed to be a real file. An explicit to_folder always wins.
  const to_folder =
    requestedToFolder ?? defaultToFolder(name, sourceStat.mtime);
  const targetDir = path.resolve(organizedRoot, to_folder);
  const targetPath = path.join(targetDir, name);

  if (!isInside(organizedRoot, targetPath)) {
    throw new Error(
      `"to_folder" escapes "${organizedRoot}": resolved to "${targetPath}"`,
    );
  }

  if (dry_run) {
    if (await destinationExists(targetPath)) {
      throw new Error(
        `Destination already exists, refusing to overwrite: "${targetPath}"`,
      );
    }
    return {
      to_folder,
      message: `Dry run: would move "${name}" to "${ORGANIZED_ROOT}/${to_folder}" inside "${root}".`,
    };
  }

  await fs.mkdir(targetDir, { recursive: true });

  // targetPath is nested under root, so a hard link gives us an atomic
  // no-overwrite move on the same filesystem while preserving file metadata.
  try {
    await fs.link(sourcePath, targetPath);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "EEXIST") {
      throw new Error(
        `Destination already exists, refusing to overwrite: "${targetPath}"`,
      );
    }
    if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP") {
      throw new Error(
        `Cannot move "${sourcePath}" without overwrite risk: the filesystem does not support the required hard link (${code}).`,
      );
    }
    throw error;
  }

  try {
    await fs.unlink(sourcePath);
  } catch (unlinkError) {
    try {
      await fs.unlink(targetPath);
    } catch (rollbackError) {
      throw new Error(
        `Created "${targetPath}" but could not remove "${sourcePath}" or roll back the destination; both paths may now exist. ` +
          `Source error: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}. ` +
          `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`,
      );
    }
    throw new Error(
      `Could not remove source after creating the destination link; the destination was rolled back: "${sourcePath}". ` +
        `${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
    );
  }

  return {
    to_folder,
    message: `Moved "${name}" to "${ORGANIZED_ROOT}/${to_folder}" inside "${root}".`,
  };
}

const server = new McpServer({ name: "file-organizer", version: "1.0.0" });

server.registerTool(
  "list_files",
  {
    description:
      "Lists the files directly inside a folder (not recursive) — subfolders are excluded, not descended into. Includes each file's last-modified date (modified) so it can be sorted by year/month/day; note that move_files derives that same date itself when to_folder is omitted, so it does not have to be passed along. Only reads file names and metadata, never file content.",
    inputSchema: z.object({
      folder: z
        .string()
        .describe(
          "Absolute path to the folder to organize, e.g. 'C:\\Users\\you\\Downloads'",
        ),
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
    return {
      content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
    };
  },
);

server.registerTool(
  "move_files",
  {
    description: `Moves one or more files from the folder being organized into a destination nested under ${ORGANIZED_ROOT}/ inside that same folder — pass a single-entry "moves" array to move just one file. Every entry is validated and moved independently: only plain files directly inside that folder are valid targets (a "name" that resolves to a subfolder, e.g. ${ORGANIZED_ROOT}/ itself, is rejected instead of moving the whole directory tree), and a destination that already exists is never overwritten. to_folder is optional and should normally be omitted: the server then applies the default scheme <extension>/<year>/<month>/<day>, taking the date from the file's own modification time (files with no extension go under ${NO_EXTENSION}/). Pass to_folder explicitly, e.g. 'pdf/2026/07/14', only when the request asks for a different layout. Each result entry reports the to_folder that was actually used. A failing entry does not stop the rest of the batch — check each entry's "ok" field in the result to see which ones failed and why. Set dry_run to preview every move without touching the filesystem.`,
    inputSchema: z.object({
      folder: z
        .string()
        .describe(
          "Absolute path to the folder being organized, e.g. 'C:\\Users\\you\\Downloads'",
        ),
      moves: z
        .array(
          z.object({
            name: z
              .string()
              .describe(
                "Name of the file to move — a plain file name, not a path",
              ),
            to_folder: z
              .string()
              .optional()
              .describe(
                `Optional override for the destination path under ${ORGANIZED_ROOT}/, e.g. 'pdf/2026/07/14'. Omit it to use the default <extension>/<year>/<month>/<day> scheme derived from the file's modification date.`,
              ),
          }),
        )
        .min(1)
        .describe(
          "The files to move. Give just the name of each file to use the default scheme; add to_folder only to override it.",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe("If true, report what would happen without moving anything"),
    }),
  },
  async ({ folder, moves, dry_run }) => {
    const root = resolveFolder(folder);
    const results: Array<{
      name: string;
      to_folder?: string;
      ok: boolean;
      message?: string;
      error?: string;
    }> = [];
    for (const { name, to_folder } of moves) {
      try {
        const moved = await moveOneFile(root, name, to_folder, dry_run);
        // Report the folder actually used, which for an omitted to_folder is the
        // default scheme the server picked.
        results.push({
          name,
          to_folder: moved.to_folder,
          ok: true,
          message: moved.message,
        });
      } catch (err) {
        // On failure the default may never have been computed, so only echo back
        // an explicitly requested to_folder.
        results.push({
          name,
          ...(to_folder === undefined ? {} : { to_folder }),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const movedCount = results.filter((r) => r.ok).length;
    const summary = `${movedCount}/${results.length} file(s) ${dry_run ? "would be moved" : "moved"} successfully.`;
    return {
      content: [
        { type: "text", text: JSON.stringify({ summary, results }, null, 2) },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
