import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const catalogPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-codex-catalog.json');

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write('codex-cli 0.147.0\n');
  process.exit(0);
}

if (args.length === 3 && args[0] === 'debug' && args[1] === 'models' && args[2] === '--bundled') {
  process.stdout.write(fs.readFileSync(catalogPath, 'utf8'));
  process.stdout.write('\n');
  process.exit(0);
}

const isResume = args[0] === 'exec' && args[1] === 'resume';
const isInitial = args[0] === 'exec';
if (!isInitial || (isResume && args[2] !== 'codex-fixture-session-001')) {
  process.stderr.write('unsupported fixture invocation\n');
  process.exit(2);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const outputPathIndex = args.indexOf('--output-last-message');
  const outputPath = outputPathIndex >= 0 ? args[outputPathIndex + 1] : undefined;
  const response = `fixture response: ${prompt}`.trim();
  if (outputPath) fs.writeFileSync(outputPath, response + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ thread_id: 'codex-fixture-session-001' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'tool', name: 'fixture.read' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'message', message: { content: [{ type: 'text', text: response }] } }) + '\n');
});
