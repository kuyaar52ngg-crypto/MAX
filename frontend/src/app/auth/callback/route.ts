import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { prisma, prismaRetry } from "@/lib/prisma";

function getSafeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }
  return value;
}

function pickFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

async function syncProfileFromUser(userId: string, name: string | null, avatar: string | null) {
  // Заводим профиль на первый OAuth-вход и обновляем аватар, если пользователь
  // не успел сменить его руками. display_name/avatar_url не перетираем, если в
  // профиле уже есть свои значения, которые отличаются от метаданных провайдера.
  try {
    const existing = await prismaRetry(() => prisma.profile.findUnique({ where: { user_id: userId } }));
    if (!existing) {
      await prismaRetry(() =>
        prisma.profile.create({
          data: {
            user_id: userId,
            display_name: name,
            avatar_url: avatar,
            green_api_url: "https://api.green-api.com",
          },
        }),
      );
      return;
    }
    const patch: { display_name?: string | null; avatar_url?: string | null } = {};
    if (!existing.display_name && name) patch.display_name = name;
    if (!existing.avatar_url && avatar) patch.avatar_url = avatar;
    if (Object.keys(patch).length > 0) {
      await prismaRetry(() =>
        prisma.profile.update({
          where: { user_id: userId },
          data: patch,
        }),
      );
    }
  } catch (error) {
    // Профиль не критичен для самого логина — не валим OAuth.
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("profile sync failed:", message);
  }
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = getSafeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const { data } = await supabase.auth.getUser();
      if (data.user) {
        const md = (data.user.user_metadata || null) as Record<string, unknown> | null;
        const name = pickFromMetadata(md, ["full_name", "name", "user_name"]) || (data.user.email ? data.user.email.split("@")[0] : null);
        const avatar = pickFromMetadata(md, ["picture", "avatar_url"]);
        await syncProfileFromUser(data.user.id, name, avatar);
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
