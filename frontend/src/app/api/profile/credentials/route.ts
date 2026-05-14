import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

async function getUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

interface ProfileRow {
  display_name: string | null;
  avatar_url: string | null;
  green_api_id: string | null;
  green_api_token: string | null;
  green_api_url: string;
}

function sanitizeProfile(profile: ProfileRow) {
  return {
    display_name: profile.display_name || "",
    avatar_url: profile.avatar_url || null,
    green_api_id: profile.green_api_id || "",
    green_api_token: profile.green_api_token || "",
    green_api_url: profile.green_api_url || "https://api.green-api.com",
    has_credentials: Boolean(profile.green_api_id && profile.green_api_token),
  };
}

function avatarFromUserMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const picture = metadata.picture;
  if (typeof picture === "string" && picture) return picture;
  const avatar = metadata.avatar_url;
  if (typeof avatar === "string" && avatar) return avatar;
  return null;
}

function nameFromUserMetadata(metadata: Record<string, unknown> | null | undefined, email: string | null) {
  if (metadata) {
    for (const key of ["full_name", "name", "user_name"]) {
      const value = metadata[key];
      if (typeof value === "string" && value) return value;
    }
  }
  if (email) return email.split("@")[0];
  return null;
}

export async function GET(_req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const metadata = (user.user_metadata || null) as Record<string, unknown> | null;
    const seedAvatar = avatarFromUserMetadata(metadata);
    const seedName = nameFromUserMetadata(metadata, user.email || null);

    let profile = await prismaRetry(() =>
      prisma.profile.findUnique({
        where: { user_id: user.id },
      }),
    );

    if (!profile) {
      profile = await prismaRetry(() =>
        prisma.profile.create({
          data: {
            user_id: user.id,
            display_name: seedName,
            avatar_url: seedAvatar,
            green_api_url: "https://api.green-api.com",
          },
        }),
      );
    } else if (seedAvatar && !profile.avatar_url) {
      // Бэкфилл аватара из user_metadata, если в БД ещё пусто. Делаем один раз
      // на чтение профиля; новые записи берут аватар сразу при create.
      profile = await prismaRetry(() =>
        prisma.profile.update({
          where: { user_id: user.id },
          data: { avatar_url: seedAvatar },
        }),
      );
    }

    return jsonResponse(sanitizeProfile(profile));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("profile credentials GET error:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as Record<string, unknown>;
    const display_name =
      typeof body.display_name === "string" ? body.display_name.trim().slice(0, 64) || null : undefined;
    const avatar_url_raw = typeof body.avatar_url === "string" ? body.avatar_url.trim() : undefined;
    const avatar_url =
      avatar_url_raw === undefined ? undefined : avatar_url_raw.length > 0 ? avatar_url_raw : null;

    const green_api_id = typeof body.green_api_id === "string" ? body.green_api_id.trim() : undefined;
    const green_api_token = typeof body.green_api_token === "string" ? body.green_api_token.trim() : undefined;
    const green_api_url_raw = typeof body.green_api_url === "string" ? body.green_api_url.trim().replace(/\/+$/, "") : undefined;
    const green_api_url = green_api_url_raw && green_api_url_raw.length > 0 ? green_api_url_raw : undefined;

    // GREEN-API credentials remain mandatory for the existing settings page,
    // but profile-only updates (name, avatar) can omit them.
    const isCredentialsUpdate =
      green_api_id !== undefined || green_api_token !== undefined || green_api_url !== undefined;
    if (isCredentialsUpdate) {
      if (!green_api_id || !green_api_token) {
        return jsonResponse({ error: "ID Instance и API Token обязательны" }, { status: 400 });
      }
    }

    const updateData: Record<string, unknown> = {};
    if (display_name !== undefined) updateData.display_name = display_name;
    if (avatar_url !== undefined) updateData.avatar_url = avatar_url;
    if (green_api_id !== undefined) updateData.green_api_id = green_api_id;
    if (green_api_token !== undefined) updateData.green_api_token = green_api_token;
    if (green_api_url !== undefined) updateData.green_api_url = green_api_url;

    const profile = await prismaRetry(() =>
      prisma.profile.upsert({
        where: { user_id: user.id },
        create: {
          user_id: user.id,
          display_name: display_name ?? user.email ?? null,
          avatar_url: avatar_url ?? null,
          green_api_id: green_api_id ?? null,
          green_api_token: green_api_token ?? null,
          green_api_url: green_api_url ?? "https://api.green-api.com",
        },
        update: updateData,
      }),
    );

    return jsonResponse(sanitizeProfile(profile));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("profile credentials POST error:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
