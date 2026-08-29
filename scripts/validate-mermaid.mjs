import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DOCS_DIR = join(process.cwd(), 'docs');

function findMdFiles(dir) {
  const files = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...findMdFiles(fullPath));
    } else if (extname(entry) === '.md') {
      files.push(fullPath);
    }
  }
  return files;
}

function extractMermaidBlocks(content) {
  const regex = /```mermaid\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({ file: match[0], code: match[1], index: match.index });
  }
  return blocks;
}

function validateMermaid(code, tempDir) {
  const tempFile = join(tempDir, `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mmd`);
  const outputFile = join(tempDir, `output-${Date.now()}.png`);
  try {
    writeFileSync(tempFile, code);
    execSync(`npx mmdc -i "${tempFile}" -o "${outputFile}" --quiet`, { stdio: 'pipe' });
    return { valid: true };
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString() : '';
    const stdout = error.stdout ? error.stdout.toString() : '';
    return { valid: false, error: stderr || stdout || error.message };
  } finally {
    try { unlinkSync(tempFile); } catch {}
    try { unlinkSync(outputFile); } catch {}
  }
}

function main() {
  const mdFiles = findMdFiles(DOCS_DIR);
  const tempDir = mkdtempSync(join(tmpdir(), 'mermaid-validate-'));
  let hasErrors = false;

  for (const file of mdFiles) {
    const content = readFileSync(file, 'utf-8');
    const blocks = extractMermaidBlocks(content);
    for (const block of blocks) {
      const result = validateMermaid(block.code, tempDir);
      if (!result.valid) {
        hasErrors = true;
        console.error(`\n❌ Invalid mermaid diagram in ${file}:`);
        console.error(`   ${result.error.trim().split('\n')[0]}`);
      }
    }
  }

  try { rmdirSync(tempDir); } catch {}

  if (hasErrors) {
    console.error('\nMermaid diagram validation failed.');
    process.exit(1);
  }

  const total = mdFiles.reduce((sum, f) => sum + extractMermaidBlocks(readFileSync(f, 'utf-8')).length, 0);
  console.log(`✅ All ${total} mermaid diagram(s) validated successfully.`);
}

main();