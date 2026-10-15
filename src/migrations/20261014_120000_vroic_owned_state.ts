import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

/**
 * Additive owned state for the shared generated-app operation protocol and the
 * Core-14 integration capabilities. These tables live in the SAME Postgres
 * database the imported Payload application already uses. This migration only
 * creates new tables; it never alters, drops or rewrites existing Payload
 * tables, records or integer primary keys.
 *
 * The operations code performs NO read-side/boot DDL: these tables must be
 * created by running this migration through the project's own Payload migration
 * runner before the signed endpoint serves writes.
 */
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "vroic_operation_receipts" (
      "operation" text NOT NULL,
      "idempotency_key" text NOT NULL,
      "action" text NOT NULL,
      "actor_id" text NOT NULL,
      "request_sha256" text NOT NULL,
      "status" text NOT NULL DEFAULT 'pending',
      "response_json" jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("operation", "idempotency_key")
    );

    CREATE TABLE IF NOT EXISTS "vroic_principal_links" (
      "principal_id" text PRIMARY KEY,
      "user_id" integer NOT NULL,
      "role" text NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "vroic_owner_nonces" (
      "nonce" text PRIMARY KEY,
      "issued_at" timestamptz NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "consumed_at" timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "vroic_store_settings" (
      "singleton" boolean PRIMARY KEY DEFAULT true,
      "data" jsonb NOT NULL,
      "revision" integer NOT NULL DEFAULT 0,
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "vroic_store_settings_singleton" CHECK ("singleton")
    );

    CREATE TABLE IF NOT EXISTS "vroic_shipping_config" (
      "singleton" boolean PRIMARY KEY DEFAULT true,
      "data" jsonb NOT NULL,
      "revision" integer NOT NULL DEFAULT 0,
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "vroic_shipping_config_singleton" CHECK ("singleton")
    );

    CREATE TABLE IF NOT EXISTS "vroic_workflow_cases" (
      "id" text PRIMARY KEY,
      "correlation_key" text NOT NULL UNIQUE,
      "subject" text,
      "title" text NOT NULL,
      "reason" text,
      "status" text NOT NULL DEFAULT 'open',
      "owner_email" text,
      "owner_principal_id" text,
      "due_at" timestamptz,
      "version" integer NOT NULL DEFAULT 1,
      "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "vroic_contact_cases" (
      "id" text PRIMARY KEY,
      "subject" text NOT NULL,
      "body" text NOT NULL,
      "customer_email" text,
      "status" text NOT NULL DEFAULT 'open',
      "replies" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "resolution" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "vroic_support_cases" (
      "id" text PRIMARY KEY,
      "order_number" text,
      "subject" text NOT NULL,
      "status" text NOT NULL DEFAULT 'open',
      "messages" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "vroic_production_runs" (
      "id" text PRIMARY KEY,
      "product_id" integer NOT NULL,
      "variant_id" integer,
      "quantity" integer NOT NULL,
      "before_stock" integer NOT NULL DEFAULT 0,
      "after_stock" integer NOT NULL DEFAULT 0,
      "status" text NOT NULL DEFAULT 'completed',
      "reason" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "vroic_reorder_policies" (
      "id" text PRIMARY KEY,
      "product_id" integer NOT NULL,
      "variant_id" integer,
      "supplier_ref" text,
      "revision" integer NOT NULL DEFAULT 1,
      "policy" jsonb NOT NULL,
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "vroic_reorder_policies_scope" UNIQUE ("product_id", "variant_id")
    );

    CREATE TABLE IF NOT EXISTS "vroic_purchase_orders" (
      "id" text PRIMARY KEY,
      "status" text NOT NULL DEFAULT 'draft',
      "currency" text NOT NULL DEFAULT 'USD',
      "supplier_ref" text,
      "notes" text,
      "expected_at" date,
      "lines" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "receipts" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "revision" integer NOT NULL DEFAULT 1,
      "revision_digest" text NOT NULL DEFAULT '',
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS "vroic_returns" (
      "id" text PRIMARY KEY,
      "order_number" text NOT NULL,
      "status" text NOT NULL DEFAULT 'requested',
      "reason" text,
      "items" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "dispositions" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "attestation" text,
      "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "vroic_returns";
    DROP TABLE IF EXISTS "vroic_purchase_orders";
    DROP TABLE IF EXISTS "vroic_reorder_policies";
    DROP TABLE IF EXISTS "vroic_production_runs";
    DROP TABLE IF EXISTS "vroic_support_cases";
    DROP TABLE IF EXISTS "vroic_contact_cases";
    DROP TABLE IF EXISTS "vroic_workflow_cases";
    DROP TABLE IF EXISTS "vroic_shipping_config";
    DROP TABLE IF EXISTS "vroic_store_settings";
    DROP TABLE IF EXISTS "vroic_owner_nonces";
    DROP TABLE IF EXISTS "vroic_principal_links";
    DROP TABLE IF EXISTS "vroic_operation_receipts";
  `)
}
