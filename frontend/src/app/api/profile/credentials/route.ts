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

function sanitizeProfile(profile: {
  green_api_id: string | null;
  green_api_token: string | null;
  green_api_url: string;
}) {
  return {
    green_api_id: profile.green_api_id || "",
    green_api_token: profile.green_api_token || "",
    green_api_url: profile.green_api_url || "https://api.green-api.com",
    has_credentials: Boolean(profile.green_api_id && profile.green_api_token),
  };
}

export async function GET(req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    let profile = await prismaRetry(() => prisma.profile.findUnique({
      where: { user_id: user.id },
    }));

    if (!profile) {
      profile = await prismaRetry(() => prisma.profile.create({
        data: {
          user_id: user.id,
          display_name: user.email || null,
          green_api_url: "https://api.green-api.com",
        },
      }));
    }

    return jsonResponse(sanitizeProfile(profile));
  } catch (error: any) {
    console.error("profile credentials GET error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const green_api_id = String(body.green_api_id || "").trim();
    const green_api_token = String(body.green_api_token || "").trim();
    const green_api_url = String(body.green_api_url || "https://api.green-api.com").trim().replace(/\/+$/, "") || "https://api.green-api.com";

    if (!green_api_id || !green_api_token) {
      return jsonResponse({ error: "ID Instance и API Token обязательны" }, { status: 400 });
    }

    const profile = await prismaRetry(() => prisma.profile.upsert({
      where: { user_id: user.id },
      create: {
        user_id: user.id,
        display_name: user.email || null,
        green_api_id,
        green_api_token,
        green_api_url,
      },
      update: {
        green_api_id,
        green_api_token,
        green_api_url,
      },
    }));

    return jsonResponse(sanitizeProfile(profile));
  } catch (error: any) {
    console.error("profile credentials POST error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
