const pad = (n) => String(n).padStart(2, '0')

// YYMMDD_ seed for map name fields, so the operator only types the descriptive part.
// Computed per call, never cached: a browser left open overnight must not stamp yesterday.
export function todayPrefix(date = new Date()) {
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}_`
}

// Default name for a 2D map flattened from a .pcd: <today>_flattened_<pcd name without its
// date>, e.g. 261007_poi_test1 -> 261007_flattened_poi_test1.
export function defaultMapName(pcdName, date = new Date()) {
  return pcdName
    ? `${todayPrefix(date)}flattened_${pcdName.replace(/^\d{6}_/, '')}`
    : todayPrefix(date)
}
