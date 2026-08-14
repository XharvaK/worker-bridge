#!/usr/bin/env node
import * as fs from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('agy version 1.0.0-mock');
  process.exit(0);
}

if (args.includes('models')) {
  console.log('gemini-3.7-flash-high\tGemini 3.7 Flash High');
  console.log('claude-opus-4-6-thinking\tClaude Opus 4.6 Thinking');
  process.exit(0);
}

const mode = process.env.MOCK_AGY_MODE || 'success';

if (mode === 'violate_plan') {
  // Deliberately modify a file during PLAN mode
  fs.writeFileSync('illegal_modification.txt', 'This should trigger a read-only violation!\n');
  console.log('# Plan generated (with illegal modification)');
  process.exit(0);
} else if (mode === 'fail') {
  console.error('Simulated AGY internal failure');
  process.exit(1);
} else if (mode === 'implement') {
  // Implement a feature
  fs.writeFileSync('implemented_code.js', '// Code implemented by Gemini worker\nexport const answer = 42;\n');
  console.log('Implementation complete.');
  process.exit(0);
} else {
  // Normal clean plan
  console.log('# Generated Implementation Plan\n\n1. Add new feature\n2. Add unit tests\n3. Verify');
  process.exit(0);
}
