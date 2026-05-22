-- Enhanced Broadcast Scheduling: new models and ScheduledBroadcast extensions.
-- Models: GreenInstance, FollowUpChain, FollowUpRecipient, ABTest, ABTestRecipient, CalendarException, ScheduleTemplate

-- AlterTable: add new fields to scheduled_broadcasts
ALTER TABLE "public"."scheduled_broadcasts"
    ADD COLUMN "instance_id" BIGINT,
    ADD COLUMN "adaptive_throttle" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "follow_up_chain_id" BIGINT,
    ADD COLUMN "ab_test_id" BIGINT;

-- CreateTable: green_instances
CREATE TABLE "public"."green_instances" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "id_instance" TEXT NOT NULL,
    "api_token" TEXT NOT NULL,
    "api_url" TEXT NOT NULL DEFAULT 'https://api.green-api.com',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "green_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "green_instances_user_id_id_instance_key" ON "public"."green_instances"("user_id", "id_instance");

-- CreateIndex
CREATE INDEX "green_instances_user_id_idx" ON "public"."green_instances"("user_id");

-- CreateTable: follow_up_chains
CREATE TABLE "public"."follow_up_chains" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "scheduled_broadcast_id" BIGINT NOT NULL,
    "steps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_up_chains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "follow_up_chains_user_id_status_idx" ON "public"."follow_up_chains"("user_id", "status");

-- CreateIndex
CREATE INDEX "follow_up_chains_scheduled_broadcast_id_idx" ON "public"."follow_up_chains"("scheduled_broadcast_id");

-- CreateTable: follow_up_recipients
CREATE TABLE "public"."follow_up_recipients" (
    "id" BIGSERIAL NOT NULL,
    "chain_id" BIGINT NOT NULL,
    "phone" TEXT NOT NULL,
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_sent_at" TIMESTAMP(3),
    "next_trigger_at" TIMESTAMP(3),
    "exited_at" TIMESTAMP(3),

    CONSTRAINT "follow_up_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "follow_up_recipients_chain_id_phone_key" ON "public"."follow_up_recipients"("chain_id", "phone");

-- CreateIndex
CREATE INDEX "follow_up_recipients_chain_id_status_idx" ON "public"."follow_up_recipients"("chain_id", "status");

-- CreateIndex
CREATE INDEX "follow_up_recipients_next_trigger_at_idx" ON "public"."follow_up_recipients"("next_trigger_at");

-- CreateTable: ab_tests
CREATE TABLE "public"."ab_tests" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "scheduled_broadcast_id" BIGINT NOT NULL,
    "variants" JSONB NOT NULL,
    "test_percentage" INTEGER NOT NULL,
    "wait_hours" INTEGER NOT NULL DEFAULT 24,
    "winner_variant_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ab_tests_user_id_status_idx" ON "public"."ab_tests"("user_id", "status");

-- CreateTable: ab_test_recipients
CREATE TABLE "public"."ab_test_recipients" (
    "id" BIGSERIAL NOT NULL,
    "ab_test_id" BIGINT NOT NULL,
    "phone" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "replied" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "ab_test_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ab_test_recipients_ab_test_id_phone_key" ON "public"."ab_test_recipients"("ab_test_id", "phone");

-- CreateIndex
CREATE INDEX "ab_test_recipients_ab_test_id_variant_id_idx" ON "public"."ab_test_recipients"("ab_test_id", "variant_id");

-- CreateTable: calendar_exceptions
CREATE TABLE "public"."calendar_exceptions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "recurring_type" TEXT,
    "recurring_value" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_exceptions_user_id_idx" ON "public"."calendar_exceptions"("user_id");

-- CreateTable: schedule_templates
CREATE TABLE "public"."schedule_templates" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_templates_user_id_idx" ON "public"."schedule_templates"("user_id");
