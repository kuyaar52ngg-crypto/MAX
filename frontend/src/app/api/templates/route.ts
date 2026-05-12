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

    const templates = await prisma.template.findMany({
      where: { user_id: user.id },
      orderBy: { id: "desc" },
    });
    return NextResponse.json(templates);
  } catch (error: any) {
    console.error("templates GET error:", error);
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
    const { name, text } = body;
    if (!name || !text) {
      return NextResponse.json({ error: "name and text required" }, { status: 400 });
    }

    const template = await prisma.template.create({
      data: { user_id: user.id, name, text },
    });

    return NextResponse.json(template, { status: 201 });
  } catch (error: any) {
    console.error("templates POST error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
