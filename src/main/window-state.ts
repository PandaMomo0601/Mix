import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
export interface WindowPreference {
  schemaVersion: 1
  normalBounds: Bounds
  maximized: boolean
  displayId?: number
}
export interface WorkDisplay {
  id: number
  workArea: Bounds
}

export function parseWindowPreference(raw: string): WindowPreference | null {
  try {
    if (Buffer.byteLength(raw) > 4096) return null
    const v = JSON.parse(raw)
    const b = v?.normalBounds
    if (
      v.schemaVersion !== 1 ||
      typeof v.maximized !== 'boolean' ||
      !b ||
      [b.x, b.y, b.width, b.height].some((n) => !Number.isSafeInteger(n)) ||
      Math.abs(b.x) > 100000 ||
      Math.abs(b.y) > 100000 ||
      b.width < 100 ||
      b.height < 100 ||
      b.width > 20000 ||
      b.height > 20000
    )
      return null
    return {
      schemaVersion: 1,
      normalBounds: b,
      maximized: v.maximized,
      ...(Number.isSafeInteger(v.displayId) ? { displayId: v.displayId } : {})
    }
  } catch {
    return null
  }
}

function intersection(a: Bounds, b: Bounds): number {
  return (
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  )
}

export function restoreWindowPreference(
  preference: WindowPreference | null,
  displays: WorkDisplay[],
  primaryId: number
): {
  bounds: Bounds
  maximized: boolean
  minWidth: number
  minHeight: number
  displayId: number
} {
  if (!displays.length) throw new Error('Display work area unavailable')
  let display = displays.find((d) => d.id === preference?.displayId)
  if (!display && preference)
    display = [...displays].sort(
      (a, b) =>
        intersection(preference.normalBounds, b.workArea) -
        intersection(preference.normalBounds, a.workArea)
    )[0]
  if (
    !display ||
    (preference &&
      !intersection(preference.normalBounds, display.workArea) &&
      !displays.some((d) => d.id === preference.displayId))
  )
    display = displays.find((d) => d.id === primaryId) ?? displays[0]
  const area = display.workArea
  const minWidth = Math.min(640, area.width),
    minHeight = Math.min(480, area.height)
  const width = Math.min(area.width, Math.max(minWidth, preference?.normalBounds.width ?? 1100))
  const height = Math.min(area.height, Math.max(minHeight, preference?.normalBounds.height ?? 760))
  const x = Math.max(
    area.x,
    Math.min(
      area.x + area.width - width,
      preference?.normalBounds.x ?? Math.round(area.x + (area.width - width) / 2)
    )
  )
  const y = Math.max(
    area.y,
    Math.min(
      area.y + area.height - height,
      preference?.normalBounds.y ?? Math.round(area.y + (area.height - height) / 2)
    )
  )
  return {
    bounds: { x, y, width, height },
    maximized: preference?.maximized ?? false,
    minWidth,
    minHeight,
    displayId: display.id
  }
}

export class WindowStateFile {
  constructor(private readonly path: string) {}
  read(): WindowPreference | null {
    try {
      return parseWindowPreference(readFileSync(this.path, 'utf8'))
    } catch {
      return null
    }
  }
  write(value: WindowPreference): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(this.path + '.tmp', JSON.stringify(value), { mode: 0o600 })
      renameSync(this.path + '.tmp', this.path)
    } catch {
      /* Window preferences are recoverable and must not block closing. */
    }
  }
}
