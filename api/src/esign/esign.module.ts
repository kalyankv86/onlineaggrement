import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EsignProvider } from './provider.interface';
import { MockEsignProvider } from './providers/mock.provider';
import { EsignService } from './esign.service';

/**
 * Provider selection happens once, here. Adding the contracted ESP/ASP adapter
 * (DEC-002) means adding one class in ./providers and one case below — nothing
 * else in the codebase changes.
 */
@Module({
  providers: [
    MockEsignProvider,
    {
      provide: EsignProvider,
      inject: [ConfigService, MockEsignProvider],
      useFactory: (config: ConfigService, mock: MockEsignProvider): EsignProvider => {
        const name = config.get<string>('esign.provider');
        switch (name) {
          case 'mock':
            return mock;
          default:
            throw new Error(
              `Unknown ESIGN_PROVIDER "${name}". Implement an EsignProvider in ` +
                'src/esign/providers/ and register it here (DEC-002).',
            );
        }
      },
    },
    EsignService,
  ],
  exports: [EsignService, EsignProvider, MockEsignProvider],
})
export class EsignModule {}
