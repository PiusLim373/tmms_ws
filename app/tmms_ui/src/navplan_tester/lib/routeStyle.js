// How route rows look. They borrow C2's pin types, so C2MapCanvas draws them with C2's
// glyphs and gives poi / home a heading handle. map_switch is a type C2MapCanvas does not
// know: it draws it as a solid disc in --pin-simple blue, with no heading of its own, so the
// page draws that heading and the popover's dial sets it.
export const CANVAS_TYPE = {
  simple: 'simple', poi: 'action', home: 'home', map_switch: 'map_switch',
}

// The disc as C2MapCanvas fills it, and a lighter blue that stays readable as text.
export const SWITCH_FILL = 'var(--pin-simple)'
export const SWITCH_TEXT = '#60A5FA'
