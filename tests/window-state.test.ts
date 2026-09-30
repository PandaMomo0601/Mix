import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWindowPreference,
  restoreWindowPreference,
  WindowStateFile
} from '../src/main/window-state'
const displays = [
  { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } },
  { id: 2, workArea: { x: -1920, y: 0, width: 1920, height: 1080 } }
]
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })))
it('uses the accepted default size and centers inside the primary work area', () => {
  expect(restoreWindowPreference(null, displays, 1)).toMatchObject({
    bounds: { x: 170, y: 83, width: 1100, height: 760 },
    maximized: false,
    minWidth: 640,
    minHeight: 480
  })
})
it('restores a negative-coordinate monitor and maximized state independently of normal bounds', () => {
  const preference = {
    schemaVersion: 1 as const,
    normalBounds: { x: -1800, y: 50, width: 900, height: 600 },
    maximized: true,
    displayId: 2
  }
  expect(restoreWindowPreference(preference, displays, 1)).toMatchObject({
    bounds: preference.normalBounds,
    maximized: true,
    displayId: 2
  })
})
it('rescues a removed monitor and oversized bounds into the remaining usable work area', () => {
  const preference = {
    schemaVersion: 1 as const,
    normalBounds: { x: -1800, y: -100, width: 3000, height: 1800 },
    maximized: false,
    displayId: 2
  }
  expect(restoreWindowPreference(preference, [displays[0]], 1).bounds).toEqual(displays[0].workArea)
  expect(
    restoreWindowPreference(
      null,
      [{ id: 3, workArea: { x: 5, y: 40, width: 500, height: 400 } }],
      3
    )
  ).toMatchObject({
    bounds: { x: 5, y: 40, width: 500, height: 400 },
    minWidth: 500,
    minHeight: 400
  })
})
it('ignores corrupt, oversized or unsupported preferences', () => {
  for (const raw of [
    'null',
    '{broken',
    JSON.stringify({ schemaVersion: 2 }),
    ' '.repeat(5000),
    JSON.stringify({
      schemaVersion: 1,
      maximized: false,
      normalBounds: { x: 0, y: 0, width: -2, height: 760 }
    })
  ])
    expect(parseWindowPreference(raw)).toBeNull()
})
it('persists normal bounds and can recover after file corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mix-window-unit-'))
  dirs.push(dir)
  const path = join(dir, 'window.json'),
    file = new WindowStateFile(path)
  const preference = {
    schemaVersion: 1 as const,
    normalBounds: { x: 20, y: 50, width: 800, height: 600 },
    maximized: false
  }
  file.write(preference)
  expect(new WindowStateFile(path).read()).toEqual(preference)
  writeFileSync(path, '{broken')
  expect(file.read()).toBeNull()
})
