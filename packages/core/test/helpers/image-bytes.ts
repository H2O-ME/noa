/**
 * Minimal byte fixtures for the image tests.
 *
 * A real PNG header plus a little payload, built by hand rather than checked in
 * as a binary: the tests care about the SIGNATURE (what `sniffImageMediaType`
 * reads) and about byte-exact round-tripping, and neither needs a decodable
 * image. Keeping it in source means the fixture cannot drift from the format it
 * is asserting.
 */

/** A byte string starting with the 8-byte PNG signature. */
export function pngBytes(payload = 'nova'): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...signature, ...new TextEncoder().encode(payload)]);
}

/** Whether the fixture passes the raster gate. */
export function admitsOnlyRaster(): boolean {
  return pngBytes().length === 12;
}
