'use strict';
/**
 * Stage 2 of the document pipeline (SDD v1.1 §B1/§B3 step 4): take a flat rendered
 * PDF and add the three reserved AcroForm signature widgets, before any signature
 * exists. After this runs the byte stream is the *signing baseline* and is never
 * re-rendered or re-flattened.
 *
 * In the API this is the `Preparer`; the flat input comes from the Playwright
 * `Renderer`. Here we also synthesise the flat input so the spike is standalone.
 */

const {
  PDFDocument, StandardFonts, PDFName, PDFString, rgb,
} = require('pdf-lib');

const FIELDS = [
  { name: 'GTIDS_Agent', label: 'Agent', x: 60 },
  { name: 'GTIDS_Employee', label: 'Employee (approval)', x: 215 },
  { name: 'GTIDS_MD', label: 'Managing Director', x: 370 },
];
const WIDGET = { y: 90, w: 150, h: 70 };

/** Stand-in for the Playwright renderer: a flat, unsigned agreement page. */
async function renderFlatAgreement({ agreementNumber, agentName, employeeName, mdName }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`GTIDS Agreement ${agreementNumber}`);
  doc.setProducer('GTIDS Agreement Portal');
  doc.setCreator('GTIDS Agreement Portal');

  const page = doc.addPage([595.28, 841.89]); // A4
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const text = (s, x, y, size = 11, font = helv) =>
    page.drawText(s, { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });

  text('GRAMTARANG INCLUSIVE DEVELOPMENT SERVICES', 60, 780, 13, bold);
  text('Agreement executed on Rs.100 non-judicial stamp paper', 60, 762, 9);
  page.drawLine({ start: { x: 60, y: 752 }, end: { x: 535, y: 752 }, thickness: 1 });

  text(`Agreement Number: ${agreementNumber}`, 60, 720, 11, bold);
  text(`Agent: ${agentName}`, 60, 700);
  text(`Employee: ${employeeName}`, 60, 684);
  text(`Managing Director: ${mdName}`, 60, 668);

  text('This document is generated once and never re-rendered. Every subsequent', 60, 630);
  text('signature and attestation is applied as a PDF incremental update, so that', 60, 614);
  text('earlier signatures remain cryptographically valid (SRS v1.1 §8.1).', 60, 598);

  // Reserved signature areas — drawn so the widgets sit on a visible baseline.
  for (const f of FIELDS) {
    page.drawRectangle({
      x: f.x, y: WIDGET.y, width: WIDGET.w, height: WIDGET.h,
      borderColor: rgb(0.65, 0.65, 0.65), borderWidth: 0.75,
    });
    text(f.label, f.x + 4, WIDGET.y - 14, 8);
  }

  return { bytes: Buffer.from(await doc.save({ useObjectStreams: false })), fontName: 'Helvetica' };
}

/**
 * Add the three signature widgets + AcroForm to a flat PDF.
 * Returns the prepared (still unsigned) byte stream.
 */
async function prepareSignatureFields(flatBytes) {
  const doc = await PDFDocument.load(flatBytes);
  const page = doc.getPage(0);
  const helv = await doc.embedFont(StandardFonts.Helvetica);

  const fieldRefs = FIELDS.map((f) => {
    const widget = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFString.of(f.name),
      Rect: [f.x, WIDGET.y, f.x + WIDGET.w, WIDGET.y + WIDGET.h],
      F: 4, // Print
      P: page.ref,
    });
    return doc.context.register(widget);
  });

  page.node.set(PDFName.of('Annots'), doc.context.obj(fieldRefs));

  const acroForm = doc.context.obj({
    Fields: fieldRefs,
    SigFlags: 3, // SignaturesExist | AppendOnly
    DA: PDFString.of('/Helv 0 Tf 0 g'),
    DR: doc.context.obj({ Font: doc.context.obj({ Helv: helv.ref }) }),
  });
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acroForm));

  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

module.exports = { renderFlatAgreement, prepareSignatureFields, FIELDS, WIDGET };
