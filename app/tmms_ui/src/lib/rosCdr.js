// Decoders for ROS 2 messages delivered as raw CDR bytes, i.e. rosbridge's
// compression 'cbor-raw'. roslib only unwraps the CBOR envelope ({ secs, nsecs, bytes }), so
// the message itself has to be read here.
//
// Why raw at all: rosbridge shares ONE ROS subscription per topic between every websocket
// client, and the first client to subscribe fixes whether it is raw or decoded. Lichtblick
// asks for cbor-raw on every topic, so any topic a live Lichtblick layout also shows must be
// requested raw here too -- otherwise whichever page opens second receives nothing.
//
// Only the types we actually receive raw are decoded. Both are at most 4-byte aligned, so
// plain CDR and XCDR2 lay them out identically.

const ENCAPSULATION_BYTES = 4

function reader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Encapsulation kind is big-endian in byte 0..1; an odd kind means little-endian payload.
  const le = (bytes[1] & 1) === 1
  let o = ENCAPSULATION_BYTES

  // Alignment is measured from the end of the encapsulation header, not from byte 0.
  const align4 = () => {
    const r = (o - ENCAPSULATION_BYTES) % 4
    if (r) o += 4 - r
  }

  const r = {
    u32() { align4(); const v = view.getUint32(o, le); o += 4; return v },
    i32() { align4(); const v = view.getInt32(o, le); o += 4; return v },
    f32() { align4(); const v = view.getFloat32(o, le); o += 4; return v },
    string() {
      // The length counts the trailing NUL, which is not part of the string.
      const len = r.u32()
      const s = new TextDecoder().decode(bytes.subarray(o, o + Math.max(0, len - 1)))
      o += len
      return s
    },
    // Zero-copy: a view onto the received buffer. uint8 needs no alignment.
    u8Array() {
      const n = r.u32()
      const out = bytes.subarray(o, o + n)
      o += n
      return out
    },
    f32Array() {
      const n = r.u32()
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) { out[i] = view.getFloat32(o, le); o += 4 }
      return out
    },
    header() {
      const sec = r.i32()
      const nanosec = r.u32()
      return { stamp: { sec, nanosec }, frame_id: r.string() }
    },
  }
  return r
}

/** sensor_msgs/LaserScan. Ranges keep their Infinity entries (use_inf upstream). */
export function decodeLaserScanCdr(bytes) {
  const r = reader(bytes)
  return {
    header: r.header(),
    angle_min: r.f32(),
    angle_max: r.f32(),
    angle_increment: r.f32(),
    time_increment: r.f32(),
    scan_time: r.f32(),
    range_min: r.f32(),
    range_max: r.f32(),
    ranges: r.f32Array(),
    intensities: r.f32Array(),
  }
}

/** sensor_msgs/CompressedImage. `data` is the encoded JPEG/PNG, as a Uint8Array view. */
export function decodeCompressedImageCdr(bytes) {
  const r = reader(bytes)
  return {
    header: r.header(),
    format: r.string(),
    data: r.u8Array(),
  }
}
