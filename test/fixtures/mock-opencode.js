#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--echo-args')) {
  console.log(JSON.stringify(args));
  process.exit(0);
}

if (args.includes('--version')) {
  console.log('1.18.15-mock');
  process.exit(0);
}

if (args.includes('models')) {
  console.log('opencode/deepseek-v4-flash-free');
  console.log(JSON.stringify({ name: 'DeepSeek V4 Flash Free', variants: { low: {}, high: {}, max: {} } }));
  console.log('opencode/hy3-free');
  console.log(JSON.stringify({ name: 'HY3 Free', variants: { low: {}, medium: {}, high: {} } }));
  console.log('opencode/laguna-s-2.1-free');
  console.log(JSON.stringify({ name: 'Laguna S 2.1 Free', variants: { low: {}, medium: {}, high: {} } }));
  console.log('opencode/nemotron-3-ultra-free');
  console.log(JSON.stringify({ name: 'Nemotron 3 Ultra Free', variants: {} }));
  console.log('opencode/nemotron-3.5-lightning-free');
  console.log(JSON.stringify({ name: 'Nemotron 3.5 Lightning Free', variants: {} }));
  process.exit(0);
}

console.log('{"sessionID":"mock-session","type":"text","text":"mock response"}');
