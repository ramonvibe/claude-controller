#!/usr/bin/env node
// Stand-in for the `claude` CLI in tests (CLAUDE_BIN). Without FAKE_SCRIPT it replays the recorded fixture;
// with it, each call consumes the next entry: {text?, structured?, isError?, sleep?, model?}.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.306 (Claude Code)');
  process.exit(0);
}
if (args[0] === '--help') {
  console.log('--print --output-format --verbose --model --effort --system-prompt --append-system-prompt --tools --allowed-tools --disallowed-tools --permission-mode --strict-mcp-config --mcp-config --disable-slash-commands --setting-sources --no-session-persistence --json-schema --max-budget-usd');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }));
  process.exit(0);
}

const stdin = fs.readFileSync(0, 'utf8');
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin }) + '\n');

if (!process.env.FAKE_SCRIPT) {
  process.stdout.write(fs.readFileSync(new URL('../fixtures/claude/stream-tool.ndjson', import.meta.url)));
  process.exit(0);
}

const script = JSON.parse(fs.readFileSync(process.env.FAKE_SCRIPT, 'utf8'));
const stateFile = process.env.FAKE_SCRIPT + '.idx';
const idx = Number(fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : 0);
fs.writeFileSync(stateFile, String(idx + 1));
const step = script[idx] ?? { isError: true, text: 'fake script exhausted' };
const model = step.model ?? args[args.indexOf('--model') + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

out({ type: 'system', subtype: 'init', model, tools: [], permissionMode: 'dontAsk' });
if (step.sleep) await new Promise((r) => setTimeout(r, step.sleep));
const text = step.text ?? JSON.stringify(step.structured ?? {});
out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1 } } } });
out({
  type: 'result',
  subtype: step.isError ? 'error_during_execution' : 'success',
  is_error: Boolean(step.isError),
  result: text,
  structured_output: step.structured,
  modelUsage: { [model]: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 0.001, canonicalModel: model } },
});
