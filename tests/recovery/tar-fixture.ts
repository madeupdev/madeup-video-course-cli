import { gzipSync } from 'node:zlib';

export type TarFixtureEntry = Readonly<{
  name: string;
  type?: '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7';
  mode?: number;
  contents?: string | Buffer;
  linkname?: string;
}>;

function writeString(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8');
}

function writeOctal(block: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeString(block, offset, length, `${encoded}\0`);
}

export function tarGzip(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents ?? '');
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o644));
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, contents.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, entry.type ?? '0');
    writeString(header, 157, 100, entry.linkname ?? '');
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    writeString(header, 148, 8, `${checksumText}\0 `);
    blocks.push(header, contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) {
      blocks.push(Buffer.alloc(padding));
    }
  }

  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
