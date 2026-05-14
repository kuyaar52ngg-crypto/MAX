-- Add avatar_url column to profiles
ALTER TABLE "public"."profiles"
ADD COLUMN IF NOT EXISTS "avatar_url" TEXT;
