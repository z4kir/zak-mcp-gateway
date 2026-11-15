/**
 * Checks a skill folder against the marketplace rules and zips it for upload.
 *
 *   node skills/pack.mjs zak-mcp-gateway     ->  skills/dist/zak-mcp-gateway.zip
 *
 * Checks: SKILL.md with `name` + `description` frontmatter, name == folder name (lowercase,
 * digits, hyphens, <= 64 chars), description <= 1024 chars; text files only (.md .txt .json
 * .yaml .yml), no symlinks, hidden files or OS junk; no key-like strings. The zip holds one
 * top-level folder named after the skill with SKILL.md at its root (paths use "/").
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
if (!name) {
  console.error("Usage: node skills/pack.mjs <skill-folder-name>");
  process.exit(1);
}
const root = path.join(here, name);
const problems = [];

// ---- SKILL.md frontmatter ----
const skillMd = fs.readFileSync(path.join(root, "SKILL.md"), "utf-8");
const fm = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
if (!fm) problems.push("SKILL.md must start with --- frontmatter ---");
const meta = {};
for (const line of (fm?.[1] ?? "").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
  if (m) meta[m[1]] = m[2].trim();
  else if (line.trim()) problems.push(`frontmatter line not "key: value": ${line.slice(0, 60)}`);
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(meta.name ?? "")) problems.push(`name "${meta.name}" must be lowercase letters, digits and hyphens`);
if (meta.name !== name) problems.push(`name "${meta.name}" must equal the folder name "${name}"`);
if ((meta.name ?? "").length > 64) problems.push("name is longer than 64 characters");
if (!meta.description) problems.push("description is missing");
if ((meta.description ?? "").length > 1024) problems.push(`description is ${meta.description.length} characters (max 1024)`);
if (/[<>]/.test(meta.description ?? "")) problems.push("description must not contain < or >");
if (!fm?.[2]?.trim()) problems.push("SKILL.md has no instructions after the frontmatter");

// ---- files ----
const TEXT = new Set([".md", ".txt", ".json", ".yaml", ".yml"]);
const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const KEYS = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (e.isSymbolicLink()) { problems.push(`symlink not allowed: ${rel}`); continue; }
    if (e.name.startsWith(".") || JUNK.has(e.name.toLowerCase())) { problems.push(`hidden or junk file not allowed: ${rel}`); continue; }
    if (e.isDirectory()) { walk(abs); continue; }
    if (!TEXT.has(path.extname(e.name).toLowerCase())) { problems.push(`only text files allowed: ${rel}`); continue; }
    const data = fs.readFileSync(abs);
    if (data.includes(0)) problems.push(`binary content in ${rel}`);
    const textContent = data.toString("utf-8");
    if (Buffer.from(textContent, "utf-8").compare(data) !== 0) problems.push(`not valid UTF-8: ${rel}`);
    if (KEYS.test(textContent)) problems.push(`key-like string in ${rel}`);
    files.push({ rel, data, mtime: fs.statSync(abs).mtime });
  }
}
walk(root);
files.sort((a, b) => (a.rel === "SKILL.md" ? -1 : b.rel === "SKILL.md" ? 1 : a.rel.localeCompare(b.rel)));

if (problems.length) {
  console.error(`${name}: ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

// ---- zip (deflate, UTF-8 names, one top-level folder) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

const dirs = new Set([`${name}/`]);
for (const f of files) {
  const parts = f.rel.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) dirs.add(`${name}/${parts.slice(0, i).join("/")}/`);
}
const now = new Date();
const entries = [
  ...[...dirs].sort().map(d => ({ zipName: d, data: Buffer.alloc(0), mtime: now, dir: true })),
  ...files.map(f => ({ zipName: `${name}/${f.rel}`, data: f.data, mtime: f.mtime, dir: false }))
];

const chunks = [];
const central = [];
let offset = 0;
for (const e of entries) {
  const nameBuf = Buffer.from(e.zipName, "utf-8");
  const body = e.dir ? e.data : zlib.deflateRawSync(e.data, { level: 9 });
  const method = e.dir ? 0 : 8;
  const crc = crc32(e.data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime(e.mtime), 10);
  local.writeUInt16LE(dosDate(e.mtime), 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(e.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, body);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt16LE(dosTime(e.mtime), 12);
  cd.writeUInt16LE(dosDate(e.mtime), 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(e.data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(e.dir ? 0x10 : 0, 38); // MS-DOS directory attribute
  cd.writeUInt32LE(offset, 42);
  central.push(cd, nameBuf);
  offset += local.length + nameBuf.length + body.length;
}
const cdBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(cdBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);
const zip = Buffer.concat([...chunks, cdBuf, end]);

const outDir = path.join(here, "dist");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${name}.zip`);
fs.writeFileSync(out, zip);
console.log(`${name}: all checks passed`);
for (const f of files) console.log(`  ${name}/${f.rel}  ${f.data.length} bytes`);
console.log(`-> ${path.relative(process.cwd(), out)}  ${zip.length} bytes  sha256 ${crypto.createHash("sha256").update(zip).digest("hex")}`);
