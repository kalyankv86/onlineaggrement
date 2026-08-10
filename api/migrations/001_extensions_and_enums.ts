import type { Knex } from 'knex';

/**
 * Extensions and domain enumerations (docs/ERD.md §2).
 *
 * The state enum is the single source of truth for SRS v1.1 §A8 — the workflow
 * state machine in src/workflow/state-machine.ts is checked against it by a unit
 * test, so a state added here without a transition rule fails the build.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS citext');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS btree_gist');

  await knex.raw(`
    CREATE TYPE agreement_status AS ENUM (
      'DRAFT',
      'READY_FOR_AGENT_SIGNATURE',
      'AGENT_SIGNING',
      'AGENT_SIGNED',
      'PENDING_EMPLOYEE_APPROVAL',
      'EMPLOYEE_APPROVING',
      'EMPLOYEE_APPROVED',
      'PENDING_MD_SIGNATURE',
      'MD_SIGNING',
      'COMPLETED',
      'REJECTED',
      'CANCELLED',
      'EXPIRED',
      'SIGNATURE_FAILED'
    );

    CREATE TYPE party_type      AS ENUM ('AGENT','EMPLOYEE','MD','WITNESS','ORGANIZATION');
    CREATE TYPE party_status    AS ENUM ('PENDING','NOTIFIED','VIEWED','ACTED','DECLINED');
    CREATE TYPE stamp_status    AS ENUM ('AVAILABLE','ALLOCATED','USED','CANCELLED');
    CREATE TYPE esign_status    AS ENUM ('INITIATED','PENDING_SIGNER','SIGNED','FAILED','EXPIRED','CANCELLED');
    CREATE TYPE signature_state AS ENUM ('UNSIGNED','AGENT_SIGNED','EMPLOYEE_ATTESTED','FINAL');
    CREATE TYPE user_type       AS ENUM ('INTERNAL','EXTERNAL');
    CREATE TYPE party_access_mode AS ENUM ('INTERNAL','EXTERNAL');
    CREATE TYPE notification_status AS ENUM ('QUEUED','SENT','DELIVERED','BOUNCED','FAILED');
    CREATE TYPE template_status AS ENUM ('DRAFT','APPROVED','RETIRED');
    CREATE TYPE document_type   AS ENUM (
      'STAMP_SCAN','GENERATED_UNSIGNED','PREPARED_UNSIGNED',
      'AGENT_SIGNED','EMPLOYEE_ATTESTED','FINAL','AUDIT_CERTIFICATE'
    );
    CREATE TYPE signature_event_type AS ENUM (
      'VIEWED','SIGN_INITIATED','SIGNED','ATTESTED','REJECTED','FAILED'
    );
    CREATE TYPE transition_trigger AS ENUM ('USER','SYSTEM','PROVIDER_CALLBACK','SCHEDULER');
    CREATE TYPE callback_outcome AS ENUM (
      'APPLIED','DUPLICATE','REJECTED_SIGNATURE','UNMATCHED','STALE'
    );
    CREATE TYPE identity_method AS ENUM ('AADHAAR_OTP_KYC','DIGILOCKER','OFFLINE_XML');
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP TYPE IF EXISTS identity_method, callback_outcome, transition_trigger,
      signature_event_type, document_type, template_status, notification_status,
      party_access_mode, user_type, signature_state, esign_status, stamp_status,
      party_status, party_type, agreement_status;
  `);
}
