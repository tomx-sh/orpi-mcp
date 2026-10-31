import { getDocumentProxy } from "unpdf";
import { NeotimmError } from "./neotimm";

// Extract selected pages only; never fan out over an entire large PDF.
export async function readPdf(bytes: Uint8Array, startPage = 1, pageCount = 3, textOffset = 0) {
  if (!Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 5) {
    throw new NeotimmError("Choose a starting page of at least 1 and between 1 and 5 pages.");
  }
  if (!Number.isInteger(textOffset) || textOffset < 0) throw new NeotimmError("Text offset must be a nonnegative integer.");
  let pdf;
  try {
    pdf = await getDocumentProxy(bytes, {
      useSystemFonts: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      maxImageSize: 0,
      verbosity: 0,
    });
    if (startPage > pdf.numPages) throw new NeotimmError("The starting page exceeds the document's page count.");
    const lastPage = Math.min(pdf.numPages, startPage + pageCount - 1);
    const pages = [];
    for (let number = startPage; number <= lastPage; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      const truncated = text.length > textOffset + 10_000;
      pages.push({ page: number, text: text.slice(textOffset, textOffset + 10_000), truncated, textOffset, nextTextOffset: truncated ? textOffset + 10_000 : null });
      page.cleanup();
    }
    return {
      totalPages: pdf.numPages, pages,
      nextPage: lastPage < pdf.numPages ? lastPage + 1 : null,
      note: "Embedded PDF text only; no OCR. Empty text may indicate scanned pages. Tables may lose their layout. Each page returns up to 10,000 characters; request that page again with nextTextOffset to continue truncated text.",
    };
  } catch (error) {
    if (error instanceof NeotimmError) throw error;
    throw new NeotimmError("This PDF could not be read. It may be encrypted or unsupported.");
  } finally {
    await pdf?.loadingTask.destroy();
  }
}
