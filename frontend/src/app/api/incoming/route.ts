import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const incoming = await prisma.incoming.findMany({
      where: { user_id: user.id },
      orderBy: { id: "desc" },
      take: 100,
    });
    return NextResponse.json(incoming);
  } catch (error: any) {
    console.error("incoming GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
