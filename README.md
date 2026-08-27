# MCP File Organizer — demo for the techblog post "MCP in Practice"

A demo illustrating MCP through the "AI File Organization Assistant" use case: an MCP Server exposes two file-management tools (`list_files`, `move_files`; there is no `read_file`), while a custom host/agent application calls Gemini and contains the MCP Client that connects to the server. `move_files` accepts one or more moves in a single call. The model still chooses each destination from the natural-language request, but it can submit the moves as one batch. `folder` must be an absolute path allowed by the operating system and, when configured, `ALLOWED_ROOTS`. Results land in `<folder>/organized/<extension>/<year>/<month>/<day>/`. Only plain files directly inside `folder` are in scope; subfolders are excluded. The demo dataset contains 500 mock files whose modification times span the previous 365 days.

## Setup

```bash
npm ci
```

The setup was verified on 2026-08-27 with Node.js 24.15.0, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/server` 2.0.0, `@google/genai` 2.17.0, Zod 4.4.3, tsx 4.23.12, and TypeScript 7.0.2. MCP TypeScript SDK v2 uses separate client and server packages; v1 used the monolithic `@modelcontextprotocol/sdk` package.

The `mcpToTool` integration is experimental in `@google/genai` 2.17.0. This repository verifies the locked version combination; it does not claim that every MCP client version is compatible with every `@google/genai` version.

## Generating mock data

```bash
npm run generate-mock   # generates 500 mock files into storage/inbox, with mtimes spread across the last 365 days
```

Rerun this command anytime to generate a fresh dataset.

## Running the custom host/agent (requires a Gemini API key)

`client/client.ts` is a custom host/agent application. It creates an MCP Client, connects that client to the File MCP Server, and exposes the discovered tools to Gemini through `mcpToTool`. Gemini then chooses the tool and arguments through automatic function calling. The application reads the key from `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or `API_KEY` in that order. `MODEL` is optional; invalid or missing values fall back to `gemini-2.5-flash`.

```bash
# PowerShell
$env:GEMINI_API_KEY = "AIza..."
npm run agent
```

```bash
# bash
export GEMINI_API_KEY="AIza..."
npm run agent
```

These variables can also be set in a `.env` file in the project directory; `npm run agent` automatically loads `.env` if it exists (using Node's `--env-file-if-exists` flag).

To try it on a real folder instead of `storage/inbox`, pass an absolute path as an argument, e.g. `npm run agent -- "C:\Users\you\Downloads"`.

## Safety when using real data

`server.ts` already guards against several cases before touching the filesystem:

- `folder` must be an absolute path — a relative path is rejected immediately, never silently resolved against the server process's cwd.
- `name` must be a bare file name (no `/`, `\`, or `..`) — blocks traversal outside `folder`.
- `to_folder` is resolved and then re-checked to ensure it stays within `<folder>/organized/` — blocks traversal outside via `..`.
- `move_files` refuses an entry if `name` resolves to a folder instead of a file — only plain files directly inside `folder` can be moved, so a subfolder (e.g. `organized/` itself) can never be renamed/moved as a whole.
- `move_files` creates the destination with an atomic hard link, which fails if the path already exists, and then removes the source link. This prevents the check-then-rename overwrite race while preserving file metadata. The source and destination must be on a filesystem that supports hard links; unsupported filesystems return a per-entry error instead of falling back to an overwrite-prone move.
- If source removal fails after the hard link is created, the server removes the destination as a rollback. If rollback also fails, the error identifies both paths so the duplicate links can be inspected manually.
- Pass `dry_run: true` to preview a move without creating directories or links.
- `move_files` applies these checks to each entry in `moves` independently — one bad entry (typo'd name, existing destination, ...) is reported as a failure for that entry only and does not stop the rest of the batch from moving.
- Set the `ALLOWED_ROOTS` environment variable (a list of absolute paths, delimited by `;` on Windows or `:` on Unix — following `path.delimiter`) to restrict `folder` to those roots only. If unset, the demo keeps its original behavior: accepting any absolute folder — fine for demo purposes, but `ALLOWED_ROOTS` should be set when pointing at real data. `client.ts` explicitly forwards `ALLOWED_ROOTS` to the `server.ts` subprocess it spawns — a plain child process only inherits a fixed safe env allowlist (`PATH`, `APPDATA`, ...) by default, so this variable would otherwise never reach the server.

## Structure

```
server/server.ts               MCP Server: list_files, move_files — validates allowed absolute paths, never reads file contents
client/generate-mock-inbox.ts  Generates 500 mock files into storage/inbox
client/client.ts               Custom host/agent containing an MCP Client and using Gemini via @google/genai
tests/server.test.ts           MCP integration tests that do not require a Gemini API key
storage/                       Generated by running generate-mock, not committed to the repo
```

## Testing

```bash
npm run test
npm run build
```

The integration test starts the server over stdio and checks tool discovery, file listing, successful moves, modification-time preservation, existing destinations, dry runs, unsafe inputs, directory inputs, and mixed-result batches. It does not call the Gemini API.
