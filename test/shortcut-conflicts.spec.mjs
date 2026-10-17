/**
 * The restart chord must not shadow a built-in command or a browser/OS binding.
 *
 * Two independent checks, because each covers a different way a chord can be taken:
 *
 * 1. **Built-in commands.** Every command the harness registers declares per-surface
 *    `defaults`. This scans the checkout for those declarations and compares them with
 *    this plugin's chord surface by surface.
 * 2. **Reserved combinations.** The shell refuses some chords outright before any
 *    command is involved (its own `bindingIssue` rules). Those are restated here as
 *    data, with the rule each one comes from, so a test failure points at the rule.
 *
 * The checkout scan needs a deepseek-harness source tree; set `DSH_HARNESS_CHECKOUT`
 * or keep it at the sibling path. When it is missing the scan reports that instead of
 * passing silently.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PLUGIN = join(HERE, '..')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

/** This plugin's declared chord, read from the client bundle so the test cannot drift. */
function declaredChord() {
  const source = readFileSync(join(PLUGIN, 'client', 'client.js'), 'utf8')
  const match = /"(web|desktop):macos": \{ code: "(\w+)", modifiers: \[([^\]]+)\] \}/.exec(source)
  if (match === null) throw new Error('the client bundle declares no shortcut default')
  return {
    code: match[2],
    modifiers: match[3].split(',').map(part => part.trim().replaceAll('"', '')).sort(),
  }
}

const chord = declaredChord()

console.log('the declared chord is what the tests reason about')
check('one non-modifier key plus modifiers', /^Key[A-Z]$/.test(chord.code) && chord.modifiers.length > 0, JSON.stringify(chord))

console.log('no built-in command uses the same chord')

/** Locate a deepseek-harness source tree, if this machine has one. */
function harnessRoot() {
  const configured = process.env.DSH_HARNESS_CHECKOUT
  const candidates = configured === undefined ? [join(PLUGIN, '..', '..')] : [configured]
  for (const root of candidates) {
    try {
      if (statSync(join(root, 'packages', 'client')).isDirectory()) return root
    } catch { /* not this path; try the next candidate */ }
  }
  return undefined
}

/** Every `'<runtime>:<platform>': { code, modifiers }` declaration under one directory. */
function collectDefaults(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      const text = readFileSync(path, 'utf8')
      const pattern = /'(web|desktop):(macos|windows|linux)': *\{ *code: *'(\w+)', *modifiers: *\[([^\]]*)\] *\}/g
      for (const match of text.matchAll(pattern)) {
        found.push({
          where: `${path.slice(root.length + 1)}:${match.index}`,
          surface: `${match[1]}:${match[2]}`,
          code: match[3],
          modifiers: match[4].split(',').map(part => part.trim().replaceAll("'", '')).filter(Boolean).sort(),
        })
      }
    }
  }
  walk(join(root, 'packages', 'client'))
  return found
}

const root = harnessRoot()
if (root === undefined) {
  console.log('  SKIP no deepseek-harness checkout; set DSH_HARNESS_CHECKOUT to run the scan')
} else {
  const others = collectDefaults(root)
  // A scanner that finds nothing would pass every collision check by accident.
  check('the scan sees the built-in declarations it is meant to protect',
    others.some(entry => entry.code === 'Comma' && entry.modifiers.join('+') === 'primary' && entry.surface === 'desktop:macos'),
    String(others.length))
  const same = others.filter(entry => entry.code === chord.code
    && entry.modifiers.join('+') === chord.modifiers.join('+'))
  check(`${String(others.length)} built-in declarations scanned, none collide with this chord`,
    same.length === 0, JSON.stringify(same.map(entry => `${entry.where} ${entry.surface}`)))
}

console.log('no browser or OS combination the shell refuses')

// Mirrors packages/client/shortcuts/src/configuration.ts:bindingIssue. Each group is one
// branch there; a chord inside a group is refused before any command sees it.
const REFUSED_WITHOUT_MODIFIERS = ['Escape', 'Tab', 'Space', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
const REFUSED_WITH_PRIMARY = ['KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyQ', 'KeyH']
const primary = 'primary'

check('not a bare navigation or editing key', !REFUSED_WITHOUT_MODIFIERS.includes(chord.code))
check('not a primary clipboard/close/quit key', !(chord.modifiers.includes(primary) && REFUSED_WITH_PRIMARY.includes(chord.code)))
check('not primary+A without shift', !(chord.modifiers.includes(primary) && chord.code === 'KeyA' && !chord.modifiers.includes('shift')))
check('on macOS it is not Alt without a primary modifier',
  !(chord.modifiers.includes('alt') && !chord.modifiers.includes(primary)))
check('it is not a control+meta macOS chord',
  !(chord.modifiers.includes('control') && chord.modifiers.includes('primary')))
check('web accepts it: primary plus alt or shift is the allowed family',
  chord.modifiers.includes(primary) && (chord.modifiers.includes('alt') || chord.modifiers.includes('shift')))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
