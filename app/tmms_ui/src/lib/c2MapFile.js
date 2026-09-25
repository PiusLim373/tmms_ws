
export function parseMapYaml(text) {
  const out = {}
  const image = text.match(/^\s*image\s*:\s*(.+?)\s*$/m)
  if (image) out.image = image[1].replace(/^['"]|['"]$/g, '')
  const res = text.match(/^\s*resolution\s*:\s*([-\d.eE+]+)/m)
  if (res && Number.isFinite(Number(res[1])) && Number(res[1]) > 0) out.resolution = Number(res[1])

  const origin = text.match(/^\s*origin\s*:\s*\[\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*(?:,\s*([-\d.eE+]+))?/m)
  if (origin) {
    out.origin = { x: Number(origin[1]), y: Number(origin[2]) }
    out.theta = Number(origin[3] ?? 0)
  }
  return out
}
function decodePng(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {

      URL.revokeObjectURL(url)
      resolve({ image: img, width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`${file.name} is not a PNG the browser can decode.`))
    }
    img.src = url
  })
}
export async function loadUploadedMap(files) {
  const yaml = files.find((f) => /\.ya?ml$/i.test(f.name))
  const meta = yaml ? parseMapYaml(await yaml.text()) : {}
  const named = meta.image && files.find((f) => f.name === meta.image.replace(/^.*\//, ''))
  const png = named ?? files.find((f) => /\.png$/i.test(f.name))
  if (!png) throw new Error('Pick the map .png as well as its .yaml.')
  if (!yaml) throw new Error(`Pick ${png.name.replace(/\.png$/i, '')}.yaml as well — it carries the scale and origin.`)
  if (meta.resolution == null || !meta.origin) {
    throw new Error(`${yaml.name} has no usable resolution and origin.`)
  }

  const decoded = await decodePng(png)
  return {
    name: png.name.replace(/\.png$/i, ''),
    image: decoded.image,
    bytes: png.size,
    info: {
      width: decoded.width,
      height: decoded.height,
      resolution: meta.resolution,
      origin: meta.origin,
    },
  }
}
