import { NextRequest } from "next/server";
import { jsonResponse } from "@/lib/json";
import { prisma, prismaRetry } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    await prismaRetry(() => prisma.incoming.update({
      where: { id: BigInt(id), user_id: user.id },
      data: { is_read: true },
    }));

    return jsonResponse({ marked: id });
  } catch (error: any) {
    console.error("incoming read error:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
}
