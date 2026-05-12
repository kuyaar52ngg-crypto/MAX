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
    await prisma.group.delete({
      where: { user_id_group_id: { user_id: user.id, group_id: id } },
    });
    await prisma.hiddenGroup.upsert({
      where: { user_id_group_id: { user_id: user.id, group_id: id } },
      create: { user_id: user.id, group_id: id },
      update: {},
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("groups DELETE error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
