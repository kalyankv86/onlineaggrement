import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentsService } from './documents.service';
import { PdfRenderer, PdfLibRenderer, PlaywrightRenderer } from './pdf/renderer';
import { PdfPreparer } from './pdf/preparer';
import { PdfVerifier } from './pdf/verifier';
import { StorageDriver, FilesystemStorageDriver } from './storage/storage.driver';

/**
 * The renderer is chosen at boot from configuration, so swapping it never touches
 * calling code; `assertProductionConfig` refuses to start production on the
 * development choice.
 *
 * Storage has one implementation on purpose. GTIDS owns its infrastructure and
 * documents live on a NAS export mounted on the server, so the abstraction exists
 * to keep the pipeline testable — not to leave room for a cloud object store.
 */
@Module({
  providers: [
    PdfPreparer,
    PdfVerifier,
    DocumentsService,
    {
      provide: PdfRenderer,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('pdf.renderer') === 'playwright'
          ? new PlaywrightRenderer(config)
          : new PdfLibRenderer(),
    },
    { provide: StorageDriver, useClass: FilesystemStorageDriver },
  ],
  exports: [DocumentsService, PdfVerifier, PdfPreparer, StorageDriver],
})
export class DocumentsModule {}
