-- Anti-ban protection: persistent config, operation runs, and incident log.
-- See spec `anti-ban-protection` (Requirements 7.1, 8.2, 9.1, 10.1).

-- CreateTable
CREATE TABLE "public"."anti_ban_config" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "delay_min" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "delay_max" DOUBLE PRECISION NOT NULL DEFAULT 7.0,
    "batch_size" INTEGER NOT NULL DEFAULT 50,
    "long_pause_every_n" INTEGER NOT NULL DEFAULT 50,
    "long_pause_seconds" DOUBLE PRECISION NOT NULL DEFAULT 60.0,
    "daily_check_limit" INTEGER NOT NULL DEFAULT 1000,
    "hourly_check_limit" INTEGER NOT NULL DEFAULT 200,
    "daily_message_limit" INTEGER NOT NULL DEFAULT 500,
    "broadcast_delay_min" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "broadcast_jitter_max" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "state_poll_interval_seconds" INTEGER NOT NULL DEFAULT 30,
    "watchdog_timeout_seconds" INTEGER NOT NULL DEFAULT 120,
    "watchdog_check_interval_seconds" INTEGER NOT NULL DEFAULT 10,
    "sse_client_timeout_seconds" INTEGER NOT NULL DEFAULT 60,
    "max_retries" INTEGER NOT NULL DEFAULT 5,
    "max_consecutive_429" INTEGER NOT NULL DEFAULT 3,
    "sliding_window_n" INTEGER NOT NULL DEFAULT 20,
    "sliding_window_t" INTEGER NOT NULL DEFAULT 60,
    "incident_history_limit" INTEGER NOT NULL DEFAULT 100,
    "backoff_base_seconds" DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    "warn_on_zero_response_ratio" BOOLEAN NOT NULL DEFAULT true,
    "response_ratio_window_hours" INTEGER NOT NULL DEFAULT 24,
    "response_ratio_min_outgoing" INTEGER NOT NULL DEFAULT 50,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "anti_ban_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anti_ban_config_user_id_key" ON "public"."anti_ban_config"("user_id");

-- CreateTable
CREATE TABLE "public"."operation_runs" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "last_processed_index" INTEGER NOT NULL DEFAULT -1,
    "payload" JSONB NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "broadcast_id" BIGINT,
    "reason" TEXT,

    CONSTRAINT "operation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "operation_runs_user_id_status_idx" ON "public"."operation_runs"("user_id", "status");

-- CreateIndex
CREATE INDEX "operation_runs_user_id_started_at_idx" ON "public"."operation_runs"("user_id", "started_at");

-- CreateTable
CREATE TABLE "public"."incident_log" (
    "id" BIGSERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "operation_run_id" BIGINT,
    "kind" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incident_log_user_id_created_at_idx" ON "public"."incident_log"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "public"."incident_log" ADD CONSTRAINT "incident_log_operation_run_id_fkey" FOREIGN KEY ("operation_run_id") REFERENCES "public"."operation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
