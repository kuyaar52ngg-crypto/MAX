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

    const groups = await prisma.group.findMany({
      where: { user_id: user.id },
      orderBy: { id: "desc" },
    });
    return NextResponse.json(groups);
  } catch (error: any) {
    console.error("groups GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { group_id, name } = body;
    if (!group_id) {
      return NextResponse.json({ error: "group_id required" }, { status: 400 });
    }

    const group = await prisma.group.upsert({
      where: { user_id_group_id: { user_id: user.id, group_id } },
      create: { user_id: user.id, group_id, name: name || "" },
      update: { name: name || undefined },
    });

    return NextResponse.json(group, { status: 201 });
  } catch (error: any) {
    console.error("groups POST error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
