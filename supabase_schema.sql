-- ═══════════════════════════════════════════════════════════════════════════════
-- MAX Messenger — Supabase Database Schema
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Profiles (per-user Green API credentials) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  display_name TEXT,
  green_api_id TEXT,
  green_api_token TEXT,
  green_api_url TEXT DEFAULT 'https://api.green-api.com',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"   ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = user_id);

-- ── Broadcasts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.broadcasts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  message TEXT NOT NULL DEFAULT '',
  total INT DEFAULT 0,
  sent INT DEFAULT 0,
  not_found INT DEFAULT 0,
  failed INT DEFAULT 0,
  status TEXT DEFAULT 'running',
  file_url TEXT,
  file_name TEXT,
  use_typing BOOLEAN DEFAULT false
);

ALTER TABLE public.broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own broadcasts" ON public.broadcasts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users create own broadcasts" ON public.broadcasts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own broadcasts" ON public.broadcasts FOR UPDATE USING (auth.uid() = user_id);

-- ── Recipients ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.recipients (
  id BIGSERIAL PRIMARY KEY,
  broadcast_id BIGINT REFERENCES public.broadcasts(id) ON DELETE CASCADE NOT NULL,
  phone TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  message_id TEXT,
  sent_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own recipients" ON public.recipients
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.broadcasts b WHERE b.id = broadcast_id AND b.user_id = auth.uid())
  );
CREATE POLICY "Users create own recipients" ON public.recipients
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.broadcasts b WHERE b.id = broadcast_id AND b.user_id = auth.uid())
  );

-- ── Delivery Statuses ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.delivery_statuses (
  id BIGSERIAL PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  timestamp TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.delivery_statuses ENABLE ROW LEVEL SECURITY;

-- Public read for delivery statuses (linked through recipients)
CREATE POLICY "Authenticated users read delivery statuses" ON public.delivery_statuses
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users write delivery statuses" ON public.delivery_statuses
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users update delivery statuses" ON public.delivery_statuses
  FOR UPDATE USING (auth.role() = 'authenticated');

-- ── Templates ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.templates (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own templates" ON public.templates FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users create own templates" ON public.templates FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own templates" ON public.templates FOR DELETE USING (auth.uid() = user_id);

-- ── Incoming Messages ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.incoming (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  sender TEXT NOT NULL,
  sender_name TEXT,
  message TEXT,
  type TEXT DEFAULT 'text',
  file_url TEXT,
  received_at TIMESTAMPTZ DEFAULT now(),
  is_read BOOLEAN DEFAULT false
);

ALTER TABLE public.incoming ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own incoming" ON public.incoming FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users create own incoming" ON public.incoming FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own incoming" ON public.incoming FOR UPDATE USING (auth.uid() = user_id);

-- ── Groups ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.groups (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own groups" ON public.groups FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users create own groups" ON public.groups FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users delete own groups" ON public.groups FOR DELETE USING (auth.uid() = user_id);

-- ── Contacts Cache ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contacts_cache (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT,
  avatar_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, chat_id)
);

ALTER TABLE public.contacts_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own contacts" ON public.contacts_cache FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users upsert own contacts" ON public.contacts_cache FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own contacts" ON public.contacts_cache FOR UPDATE USING (auth.uid() = user_id);

-- ── Auto-create profile on signup ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (new.id, COALESCE(new.raw_user_meta_data->>'full_name', new.email));
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
