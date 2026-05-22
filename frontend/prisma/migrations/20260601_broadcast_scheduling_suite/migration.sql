-- Broadcast Scheduling Suite: extensions and new models.
-- Extends ScheduledBroadcast (Send Window, Smart-Time, AB Time Test, Auto-Snooze, Approval, parent_broadcast_id)
-- Extends Profile (operator-level config: approval threshold, burst limit, Telegram credentials)
-- New models: ABTimeTest, ABTimeTestRecipient, Notification, NotificationPreference
--
-- Non-destructive: every new column is NULL-able or has a DEFAULT, so existing rows are not touched.

-- =========================================================================
-- 1. Extend scheduled_broadcasts
-- =========================================================================
ALTER TABLE "public"."scheduled_broadcasts"
    ADD COLUMN "send_window_start"          TIMESTAMP(3),
    ADD COLUMN "send_window_end"            TIMESTAMP(3),
    ADD COLUMN "smart_time_window_days"     INTEGER,
    ADD COLUMN "smart_time_top_n"           INTEGER,
    ADD COLUMN "ab_time_test_id"            BIGINT,
    ADD COLUMN "auto_snooze_enabled"        BOOLEAN      NOT NULL DEFAULT false,
    ADD COLUMN "auto_snooze_threshold"      INTEGER      NOT NULL DEFAULT 3,
    ADD COLUMN "auto_snooze_minutes"        INTEGER      NOT NULL DEFAULT 30,
    ADD COLUMN "auto_snooze_window_minutes" INTEGER      NOT NULL DEFAULT 15,
    ADD COLUMN "auto_snooze_count"          INTEGER      NOT NULL DEFAULT 0,
    ADD COLUMN "approval_required"          BOOLEAN      NOT NULL DEFAULT false,
    ADD COLUMN "approval_status"            TEXT         NOT NULL DEFAULT 'none',
    ADD COLUMN "approval_user_id"           UUID,
    ADD COLUMN "approved_at"                TIMESTAMP(3),
    ADD COLUMN "rejection_reason"           TEXT,
    ADD COLUMN "parent_broadcast_id"        BIGINT;

-- CreateIndex
CREATE INDEX "scheduled_broadcasts_approval_user_id_approval_status_idx"
    ON "public"."scheduled_broadcasts" ("approval_user_id", "approval_status");

-- CreateIndex
CREATE INDEX "scheduled_broadcasts_parent_broadcast_id_idx"
    ON "public"."scheduled_broadcasts" ("parent_broadcast_id");

-- =========================================================================
-- 2. Extend profiles
-- =========================================================================
ALTER TABLE "public"."profiles"
    ADD COLUMN "approval_required_above_n" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "burst_recipient_limit"     INTEGER NOT NULL DEFAULT 100,
    ADD COLUMN "telegram_bot_token"        TEXT,
    ADD COLUMN "telegram_chat_id"          TEXT;

-- =========================================================================
-- 3. ab_time_tests
-- =========================================================================
CREATE TABLE "public"."ab_time_tests" (
    "id"                     BIGSERIAL    NOT NULL,
    "user_id"                UUID         NOT NULL,
    "scheduled_broadcast_id" BIGINT       NOT NULL,
    "slots"                  JSONB        NOT NULL,
    "winner_slot"            INTEGER,
    "wait_hours"             INTEGER      NOT NULL DEFAULT 24,
    "status"                 TEXT         NOT NULL DEFAULT 'running',
    "started_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"           TIMESTAMP(3),

    CONSTRAINT "ab_time_tests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ab_time_tests_user_id_status_idx"
    ON "public"."ab_time_tests" ("user_id", "status");

-- CreateIndex
CREATE INDEX "ab_time_tests_scheduled_broadcast_id_idx"
    ON "public"."ab_time_tests" ("scheduled_broadcast_id");

-- =========================================================================
-- 4. ab_time_test_recipients
-- =========================================================================
CREATE TABLE "public"."ab_time_test_recipients" (
    "id"              BIGSERIAL    NOT NULL,
    "ab_time_test_id" BIGINT       NOT NULL,
    "phone"           TEXT         NOT NULL,
    "slot_hour"       INTEGER      NOT NULL,
    "delivered"       BOOLEAN      NOT NULL DEFAULT false,
    "read"            BOOLEAN      NOT NULL DEFAULT false,
    "replied"         BOOLEAN      NOT NULL DEFAULT false,
    "sent_at"         TIMESTAMP(3),

    CONSTRAINT "ab_time_test_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ab_time_test_recipients_ab_time_test_id_phone_key"
    ON "public"."ab_time_test_recipients" ("ab_time_test_id", "phone");

-- CreateIndex
CREATE INDEX "ab_time_test_recipients_ab_time_test_id_slot_hour_idx"
    ON "public"."ab_time_test_recipients" ("ab_time_test_id", "slot_hour");

-- =========================================================================
-- 5. notifications
-- =========================================================================
CREATE TABLE "public"."notifications" (
    "id"                   BIGSERIAL    NOT NULL,
    "user_id"              UUID         NOT NULL,
    "kind"                 TEXT         NOT NULL,
    "payload"              JSONB        NOT NULL,
    "preference_snapshot"  JSONB        NOT NULL,
    "read_at"              TIMESTAMP(3),
    "dispatch_status"      TEXT         NOT NULL DEFAULT 'pending',
    "dispatch_attempts"    INTEGER      NOT NULL DEFAULT 0,
    "dispatch_error"       TEXT,
    "dispatched_channels"  TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx"
    ON "public"."notifications" ("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_dispatch_status_created_at_idx"
    ON "public"."notifications" ("dispatch_status", "created_at");

-- =========================================================================
-- 6. notification_preferences
-- =========================================================================
CREATE TABLE "public"."notification_preferences" (
    "id"         BIGSERIAL    NOT NULL,
    "user_id"    UUID         NOT NULL,
    "event_kind" TEXT         NOT NULL,
    "channel"    TEXT         NOT NULL,
    "enabled"    BOOLEAN      NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_event_kind_channel_key"
    ON "public"."notification_preferences" ("user_id", "event_kind", "channel");

-- CreateIndex
CREATE INDEX "notification_preferences_user_id_idx"
    ON "public"."notification_preferences" ("user_id");
