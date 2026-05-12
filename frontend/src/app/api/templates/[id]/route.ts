import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    await prisma.template.delete({
      where: { id: BigInt(id), user_id: user.id },
    });

    return NextResponse.json({ deleted: id });
  } catch (error: any) {
    console.error("templates DELETE error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
