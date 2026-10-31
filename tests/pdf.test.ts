import { expect, test } from "bun:test";
import { readPdf } from "../src/lib/pdf";

// A tiny two-page PDF fixture generated in memory, with no private documents.
function fixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    stream("BT /F1 12 Tf 72 720 Td (First page) Tj ET"),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    stream("BT /F1 12 Tf 72 720 Td (Second page) Tj ET"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, "0")} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(text);
}

function stream(text: string) { return `<< /Length ${text.length} >>\nstream\n${text}\nendstream`; }

test("extracts only the requested PDF pages and provides a continuation", async () => {
  const first = await readPdf(fixture(), 1, 1);
  expect(first.totalPages).toBe(2);
  expect(first.pages).toHaveLength(1);
  expect(first.pages[0]).toMatchObject({ page: 1, text: "First page", truncated: false });
  expect(first.nextPage).toBe(2);
  const last = await readPdf(fixture(), 2, 3);
  expect(last.pages).toHaveLength(1);
  expect(last.pages[0].text).toBe("Second page");
  expect(last.nextPage).toBeNull();
});

test("rejects invalid and out-of-range PDF requests", async () => {
  await expect(readPdf(fixture(), 3, 1)).rejects.toThrow("page count");
  await expect(readPdf(fixture(), 0, 1)).rejects.toThrow("starting page");
  await expect(readPdf(fixture(), 1, 6)).rejects.toThrow("between 1 and 5");
  await expect(readPdf(new TextEncoder().encode("invalid PDF"))).rejects.toThrow("could not be read");
});

test("can continue reading within a PDF page by text offset", async () => {
  const result = await readPdf(fixture(), 1, 1, 6);
  expect(result.pages[0]).toMatchObject({ text: "page", textOffset: 6, nextTextOffset: null });
  await expect(readPdf(fixture(), 1, 1, -1)).rejects.toThrow("nonnegative");
});
