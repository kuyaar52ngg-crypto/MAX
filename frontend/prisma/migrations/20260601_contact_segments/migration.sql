-- Contact segments + blacklist для CRM-mini.
-- Non-destructive: только CREATE TABLE и индексы.

-- ── Сохранённые группы контактов (теги) ───────────────────────────
CREATE TABLE IF NOT EXISTS "public"."contact_segments" (
    "id"         BIGSERIAL    NOT NULL,
    "user_id"    UUID         NOT NULL,
    "name"       TEXT         NOT NULL,
    "color"      TEXT         NOT NULL DEFAULT '#6b7280',
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contact_segments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_segments_user_id_name_key"
    ON "public"."contact_segments" ("user_id", "name");
CREATE INDEX IF NOT EXISTS "contact_segments_user_id_idx"
    ON "public"."contact_segments" ("user_id");

-- ── Связь контактов и сегментов (один телефон может быть в N сегментах) ─
CREATE TABLE IF NOT EXISTS "public"."contact_segment_members" (
    "id"         BIGSERIAL    NOT NULL,
    "segment_id" BIGINT       NOT NULL,
    "phone"      TEXT         NOT NULL,
    "name"       TEXT,
    "notes"      TEXT,
    "added_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contact_segment_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_segment_members_segment_id_phone_key"
    ON "public"."contact_segment_members" ("segment_id", "phone");
CREATE INDEX IF NOT EXISTS "contact_segment_members_segment_id_idx"
    ON "public"."contact_segment_members" ("segment_id");
CREATE INDEX IF NOT EXISTS "contact_segment_members_phone_idx"
    ON "public"."contact_segment_members" ("phone");

-- ── Глобальный blacklist пользователя ──────────────────────────────
-- Любой телефон в этой таблице НИКОГДА не должен получать сообщения,
-- даже если случайно попал в импорт. Backend и frontend проверяют этот
-- список перед запуском broadcast.
CREATE TABLE IF NOT EXISTS "public"."contact_blacklist" (
    "id"         BIGSERIAL    NOT NULL,
    "user_id"    UUID         NOT NULL,
    "phone"      TEXT         NOT NULL,
    "reason"     TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contact_blacklist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "contact_blacklist_user_id_phone_key"
    ON "public"."contact_blacklist" ("user_id", "phone");
CREATE INDEX IF NOT EXISTS "contact_blacklist_user_id_idx"
    ON "public"."contact_blacklist" ("user_id");
