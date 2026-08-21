import fs from "node:fs/promises";
import path from "node:path";

// Generates a mock file set for the "before the AI agent" scenario: an inbox
// folder that has accumulated mixed file types over several months, unorganized.

const INBOX = path.resolve(import.meta.dirname, "..", "storage", "inbox");
const TOTAL_FILES = 500;
const DAYS_BACK = 365;

const REPORT_KEYWORDS = ["Revenue", "Doanh thu", "Q1", "Q2", "Q3", "Q4"];

type FileSpec = {
  extension: string;
  weight: number;
  namePrefix: string;
  content: (index: number) => string;
};

const SPECS: FileSpec[] = [
  {
    extension: "txt",
    weight: 15,
    namePrefix: "report",
    content: (i) =>
      `Monthly Report #${i}\n\nRevenue: ${(Math.random() * 900_000_000 + 100_000_000).toFixed(0)} VND\nOrders: ${Math.floor(Math.random() * 2000)}\n`,
  },
  {
    extension: "txt",
    weight: 20,
    namePrefix: "note",
    content: (i) => `Ghi chú họp #${i}\n\n- Việc cần làm sau họp.\n- Người phụ trách: nhân sự #${i % 12}.\n`,
  },
  {
    extension: "jpg",
    weight: 18,
    namePrefix: "photo",
    content: () => "[placeholder binary content - jpg]",
  },
  {
    extension: "png",
    weight: 8,
    namePrefix: "screenshot",
    content: () => "[placeholder binary content - png]",
  },
  {
    extension: "pdf",
    weight: 15,
    namePrefix: "invoice",
    content: () => "[placeholder binary content - pdf]",
  },
  {
    extension: "docx",
    weight: 12,
    namePrefix: "document",
    content: () => "[placeholder binary content - docx]",
  },
  {
    extension: "csv",
    weight: 7,
    namePrefix: "data",
    content: (i) => `id,value\n${i},${Math.floor(Math.random() * 1000)}\n`,
  },
  {
    extension: "xlsx",
    weight: 5,
    namePrefix: "spreadsheet",
    content: () => "[placeholder binary content - xlsx]",
  },
];

function pickSpec(): FileSpec {
  const totalWeight = SPECS.reduce((sum, spec) => sum + spec.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const spec of SPECS) {
    if (roll < spec.weight) return spec;
    roll -= spec.weight;
  }
  return SPECS[0];
}

function randomPastDate(): Date {
  const now = Date.now();
  const offsetMs = Math.floor(Math.random() * DAYS_BACK) * 24 * 60 * 60 * 1000;
  return new Date(now - offsetMs);
}

await fs.mkdir(INBOX, { recursive: true });

const countByExtension: Record<string, number> = {};

for (let i = 1; i <= TOTAL_FILES; i++) {
  const spec = pickSpec();
  const fileName = `${spec.namePrefix}_${String(i).padStart(4, "0")}.${spec.extension}`;
  const filePath = path.join(INBOX, fileName);
  const content = spec.namePrefix === "report" && Math.random() < 0.5
    ? `${spec.content(i)}${REPORT_KEYWORDS[i % REPORT_KEYWORDS.length]}\n`
    : spec.content(i);

  await fs.writeFile(filePath, content);
  const mtime = randomPastDate();
  await fs.utimes(filePath, mtime, mtime);

  countByExtension[spec.extension] = (countByExtension[spec.extension] ?? 0) + 1;
}

console.log(`Created ${TOTAL_FILES} mock files in ${INBOX}`);
console.log("Distribution by extension:", countByExtension);
