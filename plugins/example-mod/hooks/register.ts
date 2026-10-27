/**
 * @file Exports register(on): counts tool calls, shows the count on the spinner, and answers the /tally command
 * @tags mod, hooks, slash-command, spinner-ui
 * @related plugins/example-mod/hooks/hooks.json, plugins/example-mod/tests/example-mod.test.ts
 */
import type { Register } from 'claude-code'

// The count, shared by the hooks below. It resets when the mod reloads.
let calls = 0

// Claude Code calls this once when the mod loads
export const register: Register = (on) => {
  // Runs when the session starts (and on each reload): adds the /tally command
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tally',
      description: 'Show how many tool calls Claude has made',
    })
    return next(e)
  })

  // Runs each time Claude is about to use a tool: count it, redraw, let it run
  on('tool.call', async ($, e, next) => {
    calls += 1
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Runs only for /tally: answers the command without a Claude turn
  on('command.run', { command: 'tally' }, async () => {
    return { text: 'Claude has made ' + calls + ' tool calls since this mod loaded' }
  })

  // Runs each time the spinner is drawn: keep it, append the count
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    return next({ ...e, props: { ...e.props, suffix: ' · tool calls: ' + calls + '…' } })
  })
}
