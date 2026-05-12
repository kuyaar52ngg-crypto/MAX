import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const incoming = await prismaRetry(() => prisma.incoming.findMany({
      where: { user_id: user.id },
      orderBy: { id: "desc" },
      take: 100,
    }));
    return jsonResponse(incoming);
  } catch (error: any) {
    console.error("incoming GET error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
