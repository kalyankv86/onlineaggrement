import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Knex } from 'knex';
import { KNEX, Db } from '../common/database/database.module';
import { sha256 } from '../common/util/crypto.util';
import { NotFoundError, SignatureIntegrityError } from '../common/errors/domain.errors';
import { PdfRenderer } from './pdf/renderer';
import { DocumentComposer } from './pdf/composer';
import { PdfPreparer, SIGNATURE_FIELDS } from './pdf/preparer';
import { PdfVerifier, VerificationReport } from './pdf/verifier';
import {
  prepareSignatureSlot,
  reopenSignatureSlot,
  embedSignature,
} from './pdf/incremental-signer';
import { StorageDriver, objectKey } from './storage/storage.driver';

export type DocType =
  | 'STAMP_SCAN'
  | 'UPLOADED_SOURCE'
  | 'COMPOSED_UNSIGNED'
  | 'GENERATED_UNSIGNED'
  | 'PREPARED_UNSIGNED'
  | 'AGENT_SIGNED'
  | 'EMPLOYEE_ATTESTED'
  | 'FINAL'
  | 'AUDIT_CERTIFICATE';

export type SignatureState = 'UNSIGNED' | 'AGENT_SIGNED' | 'EMPLOYEE_ATTESTED' | 'FINAL';

const FILE_NAME: Record<DocType, string> = {
  STAMP_SCAN: 'stamp-original.pdf',
  UPLOADED_SOURCE: 'agreement-as-supplied.pdf',
  COMPOSED_UNSIGNED: 'composed-unsigned.pdf',
  GENERATED_UNSIGNED: 'generated-unsigned.pdf',
  PREPARED_UNSIGNED: 'prepared-unsigned.pdf',
  AGENT_SIGNED: 'agent-signed.pdf',
  EMPLOYEE_ATTESTED: 'employee-attested.pdf',
  FINAL: 'final-md-signed.pdf',
  AUDIT_CERTIFICATE: 'audit-certificate.pdf',
};

export interface StoredVersion {
  versionId: string;
  documentId: string;
  fileKey: string;
  documentHash: string;
  sizeBytes: number;
}

/**
 * The document pipeline (SDD v1.1 §B2, §B3, §B8).
 *
 * Renderer -> Preparer -> Signer -> Verifier -> Store, with the hard rule
 * established by the Phase 2 gate: the renderer runs once, and after `prepare()`
 * the only thing permitted to touch the bytes is an incremental update.
 */
@Injectable()
export class DocumentsService {
  private readonly log = new Logger(DocumentsService.name);
  private readonly reservedBytes: number;

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly renderer: PdfRenderer,
    private readonly composer: DocumentComposer,
    private readonly preparer: PdfPreparer,
    private readonly verifier: PdfVerifier,
    private readonly storage: StorageDriver,
    config: ConfigService,
  ) {
    this.reservedBytes = config.get<number>('pdf.signatureReservedBytes') ?? 8192;
  }

  /**
   * Generate version N of an agreement: render flat, reserve the signature
   * widgets, store both artifacts. Returns the prepared (signing baseline) version.
   */
  async generate(
    params: {
      agreementId: string;
      agreementNumber: string;
      version: number;
      templateHtml: string;
      variables: Record<string, unknown>;
      stampScan?: Buffer;
    },
    db: Db = this.knex,
  ): Promise<StoredVersion & { fontObjectNumber: number }> {
    const flat = await this.renderer.render({
      agreementNumber: params.agreementNumber,
      templateHtml: params.templateHtml,
      variables: params.variables,
      stampScan: params.stampScan,
    });

    await this.store(
      { ...params, doc: flat, docType: 'GENERATED_UNSIGNED', signatureState: null },
      db,
    );

    const prepared = await this.preparer.prepare(flat);
    const stored = await this.store(
      {
        ...params,
        doc: prepared.buffer,
        docType: 'PREPARED_UNSIGNED',
        signatureState: 'UNSIGNED',
      },
      db,
    );

    return { ...stored, fontObjectNumber: prepared.fontObjectNumber };
  }

  /**
   * Signing phase 1 — reserve the signature slot and publish the digest the ESP
   * must sign. The half-written document is parked under a `pending/` key keyed by
   * nothing but its own content hash, so a ceremony that is abandoned leaves an
   * orphan object and no state, rather than a corrupt agreement.
   */
  async beginSignature(params: {
    agreementNumber: string;
    version: number;
    sourceFileKey: string;
    field: 'AGENT' | 'MD';
    signerName: string;
    reason: string;
    location: string;
  }): Promise<{
    pendingFileKey: string;
    byteRangeDigest: string;
    signaturesBefore: number;
    sourceDocumentHash: string;
  }> {
    const source = await this.storage.get(params.sourceFileKey);
    const before = this.verifier.verify(source);

    const slot = prepareSignatureSlot(source, {
      fieldName: params.field === 'AGENT' ? SIGNATURE_FIELDS.AGENT : SIGNATURE_FIELDS.MD,
      name: params.signerName,
      reason: params.reason,
      location: params.location,
      reservedBytes: this.reservedBytes,
    });

    const byteRangeDigest = sha256(slot.signedContent);
    const pendingFileKey = objectKey(
      params.agreementNumber,
      params.version,
      `pending/${params.field.toLowerCase()}-${byteRangeDigest.slice(0, 16)}.pdf`,
    );
    if (!(await this.storage.exists(pendingFileKey))) {
      await this.storage.put(pendingFileKey, slot.buffer, 'application/pdf');
    }

    return {
      pendingFileKey,
      byteRangeDigest,
      signaturesBefore: before.count,
      sourceDocumentHash: sha256(source),
    };
  }

  /**
   * Signing phase 2 — embed the PKCS#7 the ESP returned, then assert that every
   * signature on the result (new and pre-existing) verifies (SRS v1.1 §8.3).
   *
   * The slot is reconstructed from the parked bytes rather than held in memory, so
   * this works when the callback lands on a different API instance than the one
   * that started the ceremony.
   */
  async completeSignature(
    params: {
      agreementId: string;
      agreementNumber: string;
      version: number;
      pendingFileKey: string;
      field: 'AGENT' | 'MD';
      der: Buffer;
      expectedDigest: string;
      signaturesBefore: number;
    },
    db: Db = this.knex,
  ): Promise<StoredVersion & { report: VerificationReport }> {
    const pending = await this.storage.get(params.pendingFileKey);
    const slot = reopenSignatureSlot(pending);

    // The ESP signed a digest we gave it. If the bytes it applies to are not the
    // bytes we parked, something substituted the document mid-ceremony.
    const actualDigest = sha256(slot.signedContent);
    if (actualDigest !== params.expectedDigest) {
      throw new SignatureIntegrityError(
        'Parked document digest does not match the digest sent to the provider',
        { agreementId: params.agreementId, expected: params.expectedDigest, actual: actualDigest },
      );
    }

    const signed = embedSignature(slot, params.der);

    let report: VerificationReport;
    try {
      report = this.verifier.assertIntegrityAfterSigning(signed, params.signaturesBefore + 1);
    } catch (e) {
      // The bytes are discarded. A document whose earlier signatures stopped
      // verifying is never persisted and never reaches a party.
      throw new SignatureIntegrityError((e as Error).message, {
        agreementId: params.agreementId,
        field: params.field,
        signaturesBefore: params.signaturesBefore,
      });
    }

    const stored = await this.store(
      {
        ...params,
        doc: signed,
        docType: params.field === 'AGENT' ? 'AGENT_SIGNED' : 'FINAL',
        signatureState: params.field === 'AGENT' ? 'AGENT_SIGNED' : 'FINAL',
      },
      db,
    );

    return { ...stored, report };
  }

  /**
   * Build version N from an uploaded agreement (DEC-025, DEC-027).
   *
   * Converts Word to PDF if needed, puts the stamp scan first, then reserves the
   * signature widgets. The uploaded file is stored unchanged alongside the
   * composed document: with no template, that file is the only record of what
   * GTIDS intended to execute.
   */
  async composeFromUpload(
    params: {
      agreementId: string;
      agreementNumber: string;
      version: number;
      uploaded: Buffer;
      filename: string;
      contentType: string;
      stampScan?: Buffer;
    },
    db: Db = this.knex,
  ): Promise<StoredVersion & { fontObjectNumber: number; pageCount: number; convertedFromWord: boolean }> {
    const asPdf = await this.composer.toPdf(params.uploaded, params.filename, params.contentType);
    const convertedFromWord = !asPdf.equals(params.uploaded);

    await this.store(
      { ...params, doc: asPdf, docType: 'UPLOADED_SOURCE', signatureState: null },
      db,
    );

    const composed = await this.composer.compose(asPdf, params.stampScan);
    await this.store(
      { ...params, doc: composed.buffer, docType: 'COMPOSED_UNSIGNED', signatureState: null },
      db,
    );

    const prepared = await this.preparer.prepare(composed.buffer);
    const stored = await this.store(
      { ...params, doc: prepared.buffer, docType: 'PREPARED_UNSIGNED', signatureState: 'UNSIGNED' },
      db,
    );

    return {
      ...stored,
      fontObjectNumber: prepared.fontObjectNumber,
      pageCount: composed.pageCount,
      convertedFromWord,
    };
  }

  /** Store the stamp scan and hash it on upload (FR-005, SRS §7). */
  async storeStampScan(
    scan: Buffer,
    contentType: string,
  ): Promise<{ fileKey: string; documentHash: string; sizeBytes: number }> {
    const hash = sha256(scan);
    const fileKey = `stamps/${hash.slice(0, 2)}/${hash}.pdf`;
    if (!(await this.storage.exists(fileKey))) {
      await this.storage.put(fileKey, scan, contentType);
    }
    return { fileKey, documentHash: hash, sizeBytes: scan.length };
  }

  async fetch(fileKey: string): Promise<Buffer> {
    return this.storage.get(fileKey);
  }

  async signedUrl(fileKey: string): Promise<string> {
    return this.storage.signedUrl(fileKey);
  }

  /** The version an actor should currently be acting on. */
  async currentVersion(
    agreementId: string,
    version: number,
    db: Db = this.knex,
  ): Promise<{ id: string; file_key: string; document_hash: string; signature_state: SignatureState }> {
    const row = await db('agreement_versions')
      .where({ agreement_id: agreementId, version_no: version })
      .orderBy('created_at', 'desc')
      .first();
    if (!row) throw new NotFoundError('Agreement document version');
    return row;
  }

  async verifyStored(fileKey: string): Promise<VerificationReport> {
    return this.verifier.verify(await this.storage.get(fileKey));
  }

  /** Every document version with its hash — the evidence chain for FR-010. */
  async listVersions(agreementId: string, db: Db = this.knex): Promise<unknown[]> {
    return db('agreement_versions')
      .where('agreement_id', agreementId)
      .orderBy(['version_no', 'created_at'])
      .select('version_no', 'signature_state', 'document_hash', 'created_at');
  }

  private async store(
    params: {
      agreementId: string;
      agreementNumber: string;
      version: number;
      doc: Buffer;
      docType: DocType;
      signatureState: SignatureState | null;
    },
    db: Db,
  ): Promise<StoredVersion> {
    const hash = sha256(params.doc);
    const fileKey = objectKey(params.agreementNumber, params.version, FILE_NAME[params.docType]);
    await this.storage.put(fileKey, params.doc, 'application/pdf');

    let versionId: string | null = null;
    if (params.signatureState) {
      const [v] = await db('agreement_versions')
        .insert({
          agreement_id: params.agreementId,
          version_no: params.version,
          signature_state: params.signatureState,
          document_hash: hash,
          file_key: fileKey,
        })
        .returning('id');
      versionId = v.id;
    }

    const [d] = await db('agreement_documents')
      .insert({
        agreement_id: params.agreementId,
        agreement_version_id: versionId,
        doc_type: params.docType,
        file_key: fileKey,
        content_type: 'application/pdf',
        size_bytes: params.doc.length,
        document_hash: hash,
      })
      .returning('id');

    return {
      versionId: versionId ?? '',
      documentId: d.id,
      fileKey,
      documentHash: hash,
      sizeBytes: params.doc.length,
    };
  }
}
