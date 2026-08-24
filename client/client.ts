import { GoogleGenAI, mcpToTool } from "@google/genai"; // Claude: "@anthropic-ai/sdk" — Codex: "openai"
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MODEL = "gemini-2.5-flash"; // Claude: "claude-sonnet-5" — Codex: "gpt-5-codex"
const MODEL = process.env.MODEL?.toLowerCase().startsWith("gemini-") ? process.env.MODEL : DEFAULT_MODEL;
const TOOL_CALL_BUFFER = 10; // slack for the model re-calling list_files or retrying move_files

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.API_KEY; // Claude: ANTHROPIC_API_KEY — Codex: OPENAI_API_KEY

// Pass an absolute path as an argument to organize any real folder on disk,
// e.g. npm run agent -- "C:\Users\you\Downloads". Defaults to the demo's
// storage/inbox when no argument is given.
const INBOX_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(import.meta.dirname, "..", "storage", "inbox");

// list_files is non-recursive; in the worst case (the model calls move_files once per
// file instead of batching many files into one call) each file costs one tool call, so
// size maximumRemoteCalls off that upper bound instead of hard-coding a number.
const inboxEntries = await fs.readdir(INBOX_DIR, { withFileTypes: true });
const fileCount = inboxEntries.filter((entry) => entry.isFile()).length;
const MAX_TOOL_CALLS = fileCount + 1 + TOOL_CALL_BUFFER; // +1 for the list_files call
const USER_REQUEST =
  `Organize all files in "${INBOX_DIR}": sort each file by its type first, then by the year/month/day of its last-modified date. Do this now, do not ask for confirmation.`;

const serverPath = path.resolve(import.meta.dirname, "..", "server", "server.ts");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", serverPath],
  // StdioClientTransport only inherits a fixed safe allowlist (PATH, APPDATA, ...) by
  // default — ALLOWED_ROOTS must be forwarded explicitly or server.ts never sees it.
  env: { ALLOWED_ROOTS: process.env.ALLOWED_ROOTS ?? "" },
});

const mcpClient = new Client({ name: "file-organizer-agent", version: "1.0.0" });
await mcpClient.connect(transport);

// automaticFunctionCalling calls mcpClient.callTool() synchronously, one tool at a
// time, in this same process (see McpCallableTool.callTool in @google/genai) — wrap
// it here to log real progress as each tool is called, instead of seeing nothing
// until the whole request finishes.
let callCount = 0;
const originalCallTool = mcpClient.callTool.bind(mcpClient);
mcpClient.callTool = (async (params, options) => {
  callCount += 1;
  const args = params.arguments as Record<string, unknown>;
  const label =
    params.name === "move_files" && Array.isArray(args.moves) ? `${args.moves.length} file(s)` : JSON.stringify(args);
  console.log(`[${callCount}] ${params.name}(${label})`);
  return originalCallTool(params, options);
}) as typeof mcpClient.callTool;

const ai = new GoogleGenAI({ apiKey }); // reads GEMINI_API_KEY/GOOGLE_API_KEY (or API_KEY) from the environment

console.log(`User: ${USER_REQUEST}`);
console.log(`(${fileCount} file(s) found → maximumRemoteCalls = ${MAX_TOOL_CALLS})\n`);

const response = await ai.models.generateContent({
  model: MODEL,
  contents: USER_REQUEST,
  config: {
    tools: [mcpToTool(mcpClient)], // MCP support is built into @google/genai — other SDKs may need a hand-written tool-calling loop
    automaticFunctionCalling: { maximumRemoteCalls: MAX_TOOL_CALLS }, // @google/genai-specific option
  },
});

console.log(`\nTotal tool calls: ${callCount}`);
console.log(`\nGemini: ${response.text}`);

await mcpClient.close();
