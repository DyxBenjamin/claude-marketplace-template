/**
 * @file PreToolUse hook for Bash: parses the hook event from stdin and allows every call (exit 0; a block is exit 2 with the reason on stderr)
 * @tags hook, pretooluse, guard, zod
 * @related plugins/base-plugin/hooks/hooks.json, plugins/base-plugin/vendor/zod.generated.js
 */
// Harmless placeholder that allows everything. Add real rules to decide(), or
// delete the hooks/ directory and the "hooks" wiring in hooks.json.
import { readFileSync } from 'node:fs'
import { z } from '../vendor/zod.generated.js'

const BLOCK = 2

const Event = z.looseObject({
  tool_name: z.string().optional(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
})

// Returns the reason to block the call, or undefined to allow it.
function decide(_event: z.infer<typeof Event>): string | undefined {
  return undefined
}

// Claude Code passes the event as JSON on stdin.
let raw: unknown
try {
  raw = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  // Fail open: unreadable input never blocks.
  process.exit(0)
}

// Fail open: an event that does not match the schema never blocks.
const event = Event.safeParse(raw)
const reason = event.success ? decide(event.data) : undefined
if (reason !== undefined) {
  process.stderr.write(reason + '\n')
  process.exit(BLOCK)
}
process.exit(0)
