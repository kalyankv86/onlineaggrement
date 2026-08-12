import { Injectable } from '@nestjs/common';
import { PDFDocument, StandardFonts, PDFName, PDFString } from 'pdf-lib';
import { parseDocument, findObjectContaining } from './pdf-objects';

/**
 * The reserved signature regions, in workflow order (SRS v1.1 §8.1, DEC-024).
 *
 * Two, not three: the Employee approval step was removed, so no widget is
 * reserved for it. They are still placed before any signature exists — adding a
 * field later would need an incremental update carrying an AcroForm change, which
 * some readers treat as a suspicious post-signature modification.
 */
export const SIGNATURE_FIELDS = {
  AGENT: 'GTIDS_Agent',
  MD: 'GTIDS_MD',
} as const;

const WIDGET_GEOMETRY = [
  { name: SIGNATURE_FIELDS.AGENT, x: 60 },
  { name: SIGNATURE_FIELDS.MD, x: 300 },
];
const WIDGET = { y: 90, w: 200, h: 70 };

export interface PreparedDocument {
  buffer: Buffer;
  /** Needed by the attestation appearance stream, which must reference a real font. */
  fontObjectNumber: number;
}

/**
 * Stage 2: reserve the three signature widgets on the flat PDF, before any
 * signature exists.
 *
 * They are all added up front for two reasons. Adding a field later would itself
 * need an incremental update carrying an AcroForm change, which some readers
 * treat as a suspicious post-signature modification; and reserving them keeps the
 * field geometry identical across all three signers.
 *
 * The output of this stage is the *signing baseline*. Every subsequent ByteRange
 * is computed against the byte stream starting here.
 */
@Injectable()
export class PdfPreparer {
  async prepare(flatPdf: Buffer): Promise<PreparedDocument> {
    const doc = await PDFDocument.load(flatPdf);
    // The last page: with an uploaded agreement the signature band belongs at the
    // end of the document, after the stamp scan and the agreement text.
    const page = doc.getPage(doc.getPageCount() - 1);
    const helv = await doc.embedFont(StandardFonts.Helvetica);

    const fieldRefs = WIDGET_GEOMETRY.map((f) =>
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          FT: 'Sig',
          T: PDFString.of(f.name),
          Rect: [f.x, WIDGET.y, f.x + WIDGET.w, WIDGET.y + WIDGET.h],
          F: 4, // Print
          P: page.ref,
        }),
      ),
    );

    page.node.set(PDFName.of('Annots'), doc.context.obj(fieldRefs));
    doc.catalog.set(
      PDFName.of('AcroForm'),
      doc.context.register(
        doc.context.obj({
          Fields: fieldRefs,
          SigFlags: 3, // SignaturesExist | AppendOnly
          DA: PDFString.of('/Helv 0 Tf 0 g'),
          DR: doc.context.obj({ Font: doc.context.obj({ Helv: helv.ref }) }),
        }),
      ),
    );

    // useObjectStreams:false keeps a classic xref table, which the incremental
    // signer requires — it does not parse cross-reference streams.
    const buffer = Buffer.from(await doc.save({ useObjectStreams: false }));

    const index = parseDocument(buffer);
    const font = findObjectContaining(buffer, index.offsets, '/BaseFont /Helvetica');
    if (!font) throw new Error('prepared document has no Helvetica font object');

    return { buffer, fontObjectNumber: font.num };
  }

  /** Re-derive the font object number for a document prepared earlier. */
  findFontObjectNumber(pdf: Buffer): number {
    const index = parseDocument(pdf);
    const font = findObjectContaining(pdf, index.offsets, '/BaseFont /Helvetica');
    if (!font) throw new Error('document has no Helvetica font object');
    return font.num;
  }
}
