-- ScheduledBroadcast: отложенные/повторяющиеся/drip-рассылки.
-- Источник правды для Next.js-UI и Flask scheduler-а.

-- CreateTable
CREATE TABLE "public"."scheduled_broadcasts" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT,
    "message" TEXT NOT NULL,
    "contacts" JSONB NOT NULL,
    "personalized_messages" JSONB,
    "use_typing" BOOLEAN NOT NULL DEFAULT false,
    "delay_seconds" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "file_url" TEXT,
    "file_name" TEXT,

    "schedule_type" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3),

    "drip_batch_size" INTEGER,
    "drip_interval_minutes" INTEGER,
    "drip_wave_index" INTEGER NOT NULL DEFAULT 0,

    "recurring_kind" TEXT,
    "recurring_hour" INTEGER,
    "recurring_minute" INTEGER,
    "recurring_day_of_week" INTEGER,
    "recurring_day_of_month" INTEGER,
    "recurring_until" TIMESTAMP(3),

    "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
    "quiet_hours_start" INTEGER NOT NULL DEFAULT 22,
    "quiet_hours_end" INTEGER NOT NULL DEFAULT 8,
    "respect_recipient_tz" BOOLEAN NOT NULL DEFAULT false,
    "user_tz" TEXT NOT NULL DEFAULT 'UTC',

    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "next_run_at" TIMESTAMP(3),
    "last_run_at" TIMESTAMP(3),
    "last_error" TEXT,
    "runs_count" INTEGER NOT NULL DEFAULT 0,

    "bot_id_instance" TEXT,
    "bot_api_token" TEXT,
    "bot_api_url" TEXT,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_broadcasts_user_id_status_idx" ON "public"."scheduled_broadcasts"("user_id", "status");

-- CreateIndex
CREATE INDEX "scheduled_broadcasts_status_next_run_at_idx" ON "public"."scheduled_broadcasts"("status", "next_run_at");
