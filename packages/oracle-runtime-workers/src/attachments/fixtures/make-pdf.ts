/**
 * A tiny hand-built PDF for tests: one uncompressed page per entry, each
 * page's lines drawn in Helvetica. An empty entry yields a page with only a
 * filled rectangle (no text layer), like a scanned page. `padBytes` adds an
 * unreferenced stream of that many spaces (a large file with little content).
 */
export function makePdf(
  pages: string[][],
  opts: { padBytes?: number } = {},
): Uint8Array {
  const objects: string[] = [];
  // 1 = catalog, 2 = page tree, 3 = font; each page then adds two objects.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((lines, i) => {
    const escape = (line: string): string =>
      line.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream =
      lines.length === 0
        ? '0.5 g 50 50 400 600 re f'
        : `BT /F1 12 Tf 50 740 Td 16 TL ${lines
            .map((line) => `(${escape(line)}) Tj T*`)
            .join(' ')} ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`,
    );
    objects.push(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  if (opts.padBytes) {
    objects.push(
      `<< /Length ${opts.padBytes} >>\nstream\n${' '.repeat(opts.padBytes)}\nendstream`,
    );
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
