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

/**
 * Marks onboarding as seen for the current user.
 * Idempotent: subsequent calls keep the original welcomed_at timestamp.
 */
export async function POST(_req: NextRequest) {
  try {
    const user = await getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const existing = await prismaRetry(() =>
      prisma.profile.findUnique({ where: { user_id: user.id } }),
    );

    if (!existing) {
      const created = await prismaRetry(() =>
        prisma.profile.create({
          data: {
            user_id: user.id,
            display_name: user.email ?? null,
            welcomed_at: new Date(),
            green_api_url: "https://api.green-api.com",
          },
        }),
      );
      return jsonResponse({ welcomed_at: created.welcomed_at });
    }

    if (existing.welcomed_at) {
      return jsonResponse({ welcomed_at: existing.welcomed_at });
    }

    const updated = await prismaRetry(() =>
      prisma.profile.update({
        where: { user_id: user.id },
        data: { welcomed_at: new Date() },
      }),
    );
    return jsonResponse({ welcomed_at: updated.welcomed_at });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("profile welcome POST error:", message);
    return jsonResponse({ error: message }, { status: 500 });
  }
}
