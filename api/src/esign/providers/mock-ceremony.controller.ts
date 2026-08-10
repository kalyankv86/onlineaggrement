import {
  Controller,
  Get,
  Post,
  Param,
  Res,
  NotFoundException,
  Logger,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { Knex } from 'knex';
import { KNEX } from '../../common/database/database.module';
import { StorageDriver } from '../../documents/storage/storage.driver';
import { reopenSignatureSlot } from '../../documents/pdf/incremental-signer';
import { SigningService } from '../../signing/signing.service';
import { MockEsignProvider } from './mock.provider';
import { Public } from '../../auth/auth.guard';

/**
 * Stand-in for the ESP's hosted Aadhaar OTP ceremony — development and UAT only.
 *
 * `MockEsignProvider.initiateSigning` hands back a `ceremonyUrl` pointing here.
 * Without this the URL 404s and no one can walk the workflow locally, which makes
 * the mock provider useless for the demonstrations it exists to support.
 *
 * Guarded three ways: it refuses unless ESIGN_PROVIDER is `mock`; the provider
 * itself cannot be `mock` in production (`assertProductionConfig`); and the whole
 * route lives under the provider directory so the isolation test keeps it there.
 *
 * A real ESP would authenticate the signer, collect the OTP, and POST a signed
 * callback. Here the "signer" clicks a button and the result is applied through
 * the same `SigningService.completeSignature` path the callback uses.
 */
@Controller('api/v1/esign/mock-ceremony')
export class MockCeremonyController {
  private readonly log = new Logger(MockCeremonyController.name);

  constructor(
    @Inject(KNEX) private readonly knex: Knex,
    private readonly provider: MockEsignProvider,
    private readonly storage: StorageDriver,
    private readonly signing: SigningService,
    private readonly config: ConfigService,
  ) {}

  private assertEnabled(): void {
    if (this.config.get<string>('esign.provider') !== 'mock') {
      throw new NotFoundException();
    }
  }

  @Public()
  @Get(':providerTransactionId')
  async page(@Param('providerTransactionId') id: string, @Res() res: Response): Promise<void> {
    this.assertEnabled();
    const tx = await this.knex('esign_transactions')
      .where('provider_transaction_id', id)
      .first();
    if (!tx) throw new NotFoundException('Unknown signing transaction');

    const party = await this.knex('agreement_parties').where('id', tx.party_id).first();
    const agreement = await this.knex('agreements').where('id', tx.agreement_id).first();

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(ceremonyPage({
      providerTransactionId: id,
      signerName: party.name,
      partyType: party.party_type,
      agreementNumber: agreement.agreement_number,
      digest: tx.byte_range_digest,
      status: tx.status,
    }));
  }

  @Public()
  @Post(':providerTransactionId/complete')
  async complete(@Param('providerTransactionId') id: string) {
    this.assertEnabled();
    const tx = await this.knex('esign_transactions')
      .where('provider_transaction_id', id)
      .first();
    if (!tx) throw new NotFoundException('Unknown signing transaction');

    // The ESP signs the digest it was given. The mock re-derives it from the
    // parked bytes and refuses if it does not match what was registered.
    const slot = reopenSignatureSlot(await this.storage.get(tx.pending_file_key));
    this.provider.completeCeremony(id, slot.signedContent, tx.byte_range_digest);

    await this.signing.completeSignature(tx.id);
    this.log.log(`mock ceremony ${id} completed`);

    const agreement = await this.knex('agreements').where('id', tx.agreement_id).first();
    return { status: 'SIGNED', agreementStatus: agreement.status };
  }

  @Public()
  @Post(':providerTransactionId/fail')
  async fail(@Param('providerTransactionId') id: string) {
    this.assertEnabled();
    const tx = await this.knex('esign_transactions')
      .where('provider_transaction_id', id)
      .first();
    if (!tx) throw new NotFoundException('Unknown signing transaction');

    this.provider.failCeremony(id, 'OTP_MISMATCH');
    await this.signing.failSignature(tx.id, 'OTP_MISMATCH');
    return { status: 'FAILED' };
  }
}

function ceremonyPage(v: {
  providerTransactionId: string;
  signerName: string;
  partyType: string;
  agreementNumber: string;
  digest: string;
  status: string;
}): string {
  const done = v.status !== 'PENDING_SIGNER' && v.status !== 'INITIATED';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aadhaar eSign — ${v.agreementNumber}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#16181d; --muted:#5b6472; --line:#e3e6ea; --accent:#1d6f42; }
  @media (prefers-color-scheme: dark){ :root { --bg:#14161a; --card:#1c1f25; --fg:#e8eaed; --muted:#9aa4b2; --line:#2b3038; } }
  body { margin:0; font:15px/1.6 system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg);
         display:grid; place-items:center; min-height:100vh; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; max-width:460px; width:100%; }
  .banner { background:#fff4d6; color:#6b4e00; border:1px solid #f0dca4; border-radius:8px;
            padding:10px 12px; font-size:13px; margin-bottom:20px; }
  @media (prefers-color-scheme: dark){ .banner { background:#3a2f0d; color:#f0dca4; border-color:#5c4a12; } }
  h1 { font-size:19px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:20px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:0 0 20px; font-size:13px; }
  dt { color:var(--muted); } dd { margin:0; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; word-break:break-all; }
  input { width:100%; padding:10px 12px; font-size:18px; letter-spacing:.35em; text-align:center;
          border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg); margin-bottom:14px; }
  button { width:100%; padding:11px; font-size:15px; font-weight:600; border:0; border-radius:8px;
           background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:transparent; color:var(--muted); border:1px solid var(--line); margin-top:8px; font-weight:400; }
  #out { margin-top:16px; font-size:13px; white-space:pre-wrap; }
</style></head><body>
<div class="card">
  <div class="banner"><strong>Mock provider.</strong> This stands in for the CCA-licensed ESP's
  hosted Aadhaar OTP ceremony. No Aadhaar authentication happens here and any OTP is accepted.</div>
  <h1>Sign ${v.agreementNumber}</h1>
  <div class="sub">${v.signerName} &middot; ${v.partyType}</div>
  <dl>
    <dt>Transaction</dt><dd><code>${v.providerTransactionId}</code></dd>
    <dt>Document digest</dt><dd><code>${v.digest}</code></dd>
    <dt>Status</dt><dd>${v.status}</dd>
  </dl>
  ${done ? '<p>This transaction is already resolved.</p>' : `
  <input id="otp" inputmode="numeric" maxlength="6" placeholder="000000" aria-label="OTP">
  <button onclick="act('complete')">Sign with Aadhaar OTP</button>
  <button class="secondary" onclick="act('fail')">Simulate a failed OTP</button>`}
  <div id="out"></div>
</div>
<script>
async function act(what){
  const out = document.getElementById('out');
  out.textContent = 'Working…';
  try {
    const r = await fetch(location.pathname + '/' + what, { method:'POST' });
    const j = await r.json();
    out.textContent = JSON.stringify(j, null, 2) + '\\n\\nYou can close this window.';
  } catch (e) { out.textContent = 'Failed: ' + e.message; }
}
</script></body></html>`;
}
