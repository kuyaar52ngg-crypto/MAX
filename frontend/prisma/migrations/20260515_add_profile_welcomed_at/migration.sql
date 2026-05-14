-- Track first onboarding view per user
ALTER TABLE "public"."profiles"
ADD COLUMN IF NOT EXISTS "welcomed_at" TIMESTAMPTZ;
