import type { Knex } from 'knex';

/**
 * The half-signed document parked between ceremony phases.
 *
 * Signing is two-phase (see documents/pdf/incremental-signer.ts): phase 1 appends
 * the signature revision with an empty /Contents gap and publishes the digest;
 * phase 2 embeds the PKCS#7 the ESP returns. The bytes in between are parked in
 * object storage rather than held in process memory, because the callback that
 * ends the ceremony may reach a different API instance than the one that started
 * it (SDD v1.1 §B11: 2+ instances behind the load balancer).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('esign_transactions', (t) => {
    t.string('pending_file_key', 500);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('esign_transactions', (t) => {
    t.dropColumn('pending_file_key');
  });
}
