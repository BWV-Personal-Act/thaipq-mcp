import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

interface MoveEntryResult {
  name: string;
  to_folder?: string;
  ok: boolean;
  message?: string;
  error?: string;
}

interface MoveFilesResult {
  summary: string;
  results: MoveEntryResult[];
}

function parseToolText(result: unknown): unknown {
  assert.ok(result && typeof result === "object" && "content" in result);
  const { content } = result as { content: unknown };
  assert.ok(Array.isArray(content));
  const textItem = content.find(
    (item): item is { type: "text"; text: string } =>
      Boolean(item) &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "text" &&
      "text" in item,
  );
  assert.ok(textItem);
  assert.equal(typeof textItem.text, "string");
  return JSON.parse(textItem.text);
}

async function callMoveFiles(
  client: Client,
  folder: string,
  moves: Array<{ name: string; to_folder?: string }>,
  dry_run = false,
): Promise<MoveFilesResult> {
  const result = await client.callTool({
    name: "move_files",
    arguments: { folder, moves, dry_run },
  });
  return parseToolText(result) as MoveFilesResult;
}

test("file-organizer MCP server", async (t) => {
  const allowedRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mcp-file-organizer-"),
  );
  const serverPath = path.resolve(
    import.meta.dirname,
    "..",
    "server",
    "server.ts",
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", serverPath],
    env: { ALLOWED_ROOTS: allowedRoot },
  });
  const client = new Client({ name: "file-organizer-test", version: "1.0.0" });

  await client.connect(transport);
  try {
    await t.test("publishes the expected tools and lists files", async () => {
      const folder = path.join(allowedRoot, "list");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "sample.txt"), "sample");

      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
        "list_files",
        "move_files",
      ]);

      const listResult = parseToolText(
        await client.callTool({ name: "list_files", arguments: { folder } }),
      ) as Array<{ name: string; extension: string; modified: string }>;
      assert.equal(listResult.length, 1);
      assert.equal(listResult[0]?.name, "sample.txt");
      assert.equal(listResult[0]?.extension, "txt");
      assert.match(listResult[0]?.modified ?? "", /^\d{4}-\d{2}-\d{2}$/);
    });

    await t.test("moves without changing file content or mtime", async () => {
      const folder = path.join(allowedRoot, "success");
      const sourcePath = path.join(folder, "report.pdf");
      const targetPath = path.join(
        folder,
        "organized",
        "pdf",
        "2026",
        "01",
        "02",
        "report.pdf",
      );
      const modified = new Date("2026-01-02T03:04:05.000Z");
      await fs.mkdir(folder);
      await fs.writeFile(sourcePath, "report-content");
      await fs.utimes(sourcePath, modified, modified);
      const sourceStat = await fs.stat(sourcePath);

      const result = await callMoveFiles(client, folder, [
        { name: "report.pdf", to_folder: "pdf/2026/01/02" },
      ]);

      assert.equal(result.results[0]?.ok, true);
      await assert.rejects(fs.access(sourcePath));
      assert.equal(await fs.readFile(targetPath, "utf8"), "report-content");
      assert.equal((await fs.stat(targetPath)).mtimeMs, sourceStat.mtimeMs);
    });

    await t.test("does not overwrite an existing destination", async () => {
      const folder = path.join(allowedRoot, "existing");
      const targetDir = path.join(folder, "organized", "txt");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(folder, "notes.txt"), "new-content");
      await fs.writeFile(path.join(targetDir, "notes.txt"), "existing-content");

      const result = await callMoveFiles(client, folder, [
        { name: "notes.txt", to_folder: "txt" },
      ]);

      assert.equal(result.results[0]?.ok, false);
      assert.match(
        result.results[0]?.error ?? "",
        /Destination already exists/,
      );
      assert.equal(
        await fs.readFile(path.join(folder, "notes.txt"), "utf8"),
        "new-content",
      );
      assert.equal(
        await fs.readFile(path.join(targetDir, "notes.txt"), "utf8"),
        "existing-content",
      );
    });

    await t.test("dry run leaves the filesystem unchanged", async () => {
      const folder = path.join(allowedRoot, "dry-run");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "preview.csv"), "preview");

      const result = await callMoveFiles(
        client,
        folder,
        [{ name: "preview.csv", to_folder: "csv/2026/01/02" }],
        true,
      );

      assert.equal(result.results[0]?.ok, true);
      assert.equal(
        await fs.readFile(path.join(folder, "preview.csv"), "utf8"),
        "preview",
      );
      await assert.rejects(fs.access(path.join(folder, "organized")));
    });

    await t.test("rejects unsafe inputs and directory sources", async () => {
      const folder = path.join(allowedRoot, "validation");
      await fs.mkdir(path.join(folder, "subfolder"), { recursive: true });
      await fs.writeFile(path.join(folder, "escape.txt"), "escape");

      const result = await callMoveFiles(client, folder, [
        { name: "../outside.txt", to_folder: "txt" },
        { name: "subfolder", to_folder: "txt" },
        { name: "escape.txt", to_folder: "../outside" },
      ]);

      assert.deepEqual(
        result.results.map(({ ok }) => ok),
        [false, false, false],
      );
      assert.equal(
        await fs.readFile(path.join(folder, "escape.txt"), "utf8"),
        "escape",
      );
    });

    await t.test("continues a batch after one entry fails", async () => {
      const folder = path.join(allowedRoot, "batch");
      const targetDir = path.join(folder, "organized", "txt");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(folder, "move.txt"), "move");
      await fs.writeFile(path.join(folder, "blocked.txt"), "source");
      await fs.writeFile(path.join(targetDir, "blocked.txt"), "target");

      const result = await callMoveFiles(client, folder, [
        { name: "blocked.txt", to_folder: "txt" },
        { name: "move.txt", to_folder: "txt" },
      ]);

      assert.deepEqual(
        result.results.map(({ ok }) => ok),
        [false, true],
      );
      assert.equal(
        await fs.readFile(path.join(targetDir, "blocked.txt"), "utf8"),
        "target",
      );
      assert.equal(
        await fs.readFile(path.join(targetDir, "move.txt"), "utf8"),
        "move",
      );
      assert.equal(
        await fs.readFile(path.join(folder, "blocked.txt"), "utf8"),
        "source",
      );
    });

    await t.test(
      "applies the default extension/year/month/day when to_folder is omitted",
      async () => {
        const folder = path.join(allowedRoot, "default-scheme");
        const sourcePath = path.join(folder, "invoice.PDF");
        const modified = new Date("2026-03-09T15:30:00.000Z");
        await fs.mkdir(folder);
        await fs.writeFile(sourcePath, "invoice-content");
        await fs.utimes(sourcePath, modified, modified);

        const result = await callMoveFiles(client, folder, [
          { name: "invoice.PDF" },
        ]);

        assert.equal(result.results[0]?.ok, true);
        // The server reports the folder it picked, so the caller can see it.
        assert.equal(result.results[0]?.to_folder, "pdf/2026/03/09");
        assert.equal(
          await fs.readFile(
            path.join(
              folder,
              "organized",
              "pdf",
              "2026",
              "03",
              "09",
              "invoice.PDF",
            ),
            "utf8",
          ),
          "invoice-content",
        );
        await assert.rejects(fs.access(sourcePath));
      },
    );

    await t.test(
      "the default date matches what list_files reports, across timezones",
      async () => {
        const folder = path.join(allowedRoot, "default-utc");
        // 23:30 UTC is already the next day in +07:00 local time — the default has
        // to follow list_files (UTC) or the two tools would disagree on the day.
        const modified = new Date("2026-03-09T23:30:00.000Z");
        await fs.mkdir(folder);
        await fs.writeFile(path.join(folder, "late.csv"), "late");
        await fs.utimes(path.join(folder, "late.csv"), modified, modified);

        const listed = parseToolText(
          await client.callTool({ name: "list_files", arguments: { folder } }),
        ) as Array<{ name: string; modified: string }>;
        const reportedDate = listed[0]?.modified ?? "";

        const result = await callMoveFiles(client, folder, [
          { name: "late.csv" },
        ]);

        assert.equal(reportedDate, "2026-03-09");
        assert.equal(
          result.results[0]?.to_folder,
          `csv/${reportedDate.replaceAll("-", "/")}`,
        );
      },
    );

    await t.test("files without an extension get their own bucket", async () => {
      const folder = path.join(allowedRoot, "no-extension");
      const modified = new Date("2026-05-04T10:00:00.000Z");
      await fs.mkdir(folder);
      for (const name of ["README", ".env"]) {
        await fs.writeFile(path.join(folder, name), name);
        await fs.utimes(path.join(folder, name), modified, modified);
      }

      const result = await callMoveFiles(client, folder, [
        { name: "README" },
        { name: ".env" },
      ]);

      assert.deepEqual(
        result.results.map(({ ok, to_folder }) => ({ ok, to_folder })),
        [
          { ok: true, to_folder: "no-extension/2026/05/04" },
          { ok: true, to_folder: "no-extension/2026/05/04" },
        ],
      );
      assert.equal(
        await fs.readFile(
          path.join(folder, "organized", "no-extension", "2026", "05", "04", "README"),
          "utf8",
        ),
        "README",
      );
    });

    await t.test("an explicit to_folder still overrides the default", async () => {
      const folder = path.join(allowedRoot, "override");
      const modified = new Date("2026-03-09T15:30:00.000Z");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "note.txt"), "note");
      await fs.utimes(path.join(folder, "note.txt"), modified, modified);

      const result = await callMoveFiles(client, folder, [
        { name: "note.txt", to_folder: "manual/bucket" },
      ]);

      assert.equal(result.results[0]?.ok, true);
      assert.equal(result.results[0]?.to_folder, "manual/bucket");
      assert.equal(
        await fs.readFile(
          path.join(folder, "organized", "manual", "bucket", "note.txt"),
          "utf8",
        ),
        "note",
      );
      await assert.rejects(
        fs.access(path.join(folder, "organized", "txt", "2026", "03", "09")),
      );
    });

    await t.test(
      "dry run with the default reports the folder without creating it",
      async () => {
        const folder = path.join(allowedRoot, "default-dry-run");
        const modified = new Date("2026-07-14T08:00:00.000Z");
        await fs.mkdir(folder);
        await fs.writeFile(path.join(folder, "photo.jpg"), "photo");
        await fs.utimes(path.join(folder, "photo.jpg"), modified, modified);

        const result = await callMoveFiles(
          client,
          folder,
          [{ name: "photo.jpg" }],
          true,
        );

        assert.equal(result.results[0]?.ok, true);
        assert.equal(result.results[0]?.to_folder, "jpg/2026/07/14");
        assert.match(result.results[0]?.message ?? "", /^Dry run:/);
        assert.equal(
          await fs.readFile(path.join(folder, "photo.jpg"), "utf8"),
          "photo",
        );
        await assert.rejects(fs.access(path.join(folder, "organized")));
      },
    );

    await t.test(
      "a failing entry without to_folder does not invent one",
      async () => {
        const folder = path.join(allowedRoot, "default-failure");
        await fs.mkdir(path.join(folder, "subfolder"), { recursive: true });

        const result = await callMoveFiles(client, folder, [
          { name: "missing.txt" },
          { name: "subfolder" },
        ]);

        assert.deepEqual(
          result.results.map(({ ok, to_folder }) => ({ ok, to_folder })),
          [
            { ok: false, to_folder: undefined },
            { ok: false, to_folder: undefined },
          ],
        );
        assert.match(result.results[0]?.error ?? "", /Source not found/);
        assert.match(result.results[1]?.error ?? "", /is a folder, not a file/);
      },
    );
  } finally {
    try {
      await client.close();
    } finally {
      await fs.rm(allowedRoot, { recursive: true, force: true });
    }
  }
});
