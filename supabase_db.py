import os
from datetime import datetime
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

if SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY:
    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
else:
    supabase = None


def _client():
    if supabase is None:
        raise RuntimeError(
            "Supabase не настроен. Добавьте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY в .env"
        )
    return supabase


# ═══════════════════════════════════════════════════════════════════════════════
# CONTACTS CACHE
# ═══════════════════════════════════════════════════════════════════════════════

def get_contacts_cache(user_id: str, chat_ids: list) -> dict:
    """Returns cached contact info as {chat_id: {name, avatar_url, updated_at}}"""
    if not chat_ids or not user_id:
        return {}
    result = (
        _client().table("contacts_cache")
        .select("chat_id, name, avatar_url, updated_at")
        .eq("user_id", user_id)
        .in_("chat_id", chat_ids)
        .execute()
    )
    return {r["chat_id"]: r for r in result.data}


def upsert_contact_cache(user_id: str, chat_id: str, name: str = None, avatar_url: str = None):
    if not user_id:
        return
    _client().table("contacts_cache").upsert(
        {
            "user_id": user_id,
            "chat_id": chat_id,
            "name": name,
            "avatar_url": avatar_url,
            "updated_at": datetime.now().isoformat(),
        },
        on_conflict="user_id,chat_id",
    ).execute()


# ═══════════════════════════════════════════════════════════════════════════════
# BROADCASTS
# ═══════════════════════════════════════════════════════════════════════════════

def create_broadcast(user_id: str, message, total, file_url=None, file_name=None, use_typing=False):
    result = (
        _client().table("broadcasts")
        .insert(
            {
                "user_id": user_id,
                "message": message,
                "total": total,
                "file_url": file_url,
                "file_name": file_name,
                "use_typing": use_typing,
            }
        )
        .execute()
    )
    return result.data[0]["id"] if result.data else None


def update_broadcast_stats(broadcast_id, sent, not_found, failed, status="done"):
    _client().table("broadcasts").update(
        {"sent": sent, "not_found": not_found, "failed": failed, "status": status}
    ).eq("id", broadcast_id).execute()


def add_recipient(broadcast_id, phone, status, message_id=None):
    _client().table("recipients").insert(
        {
            "broadcast_id": broadcast_id,
            "phone": phone,
            "status": status,
            "message_id": message_id,
        }
    ).execute()


def get_broadcasts(user_id: str, limit=50):
    result = (
        _client().table("broadcasts")
        .select("*")
        .eq("user_id", user_id)
        .order("id", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data


def get_broadcast_recipients(broadcast_id):
    # Supabase REST supports foreign-table selects via embedded syntax
    result = (
        _client().table("recipients")
        .select("*, delivery_statuses(status)")
        .eq("broadcast_id", broadcast_id)
        .execute()
    )
    rows = []
    for r in result.data:
        row = dict(r)
        ds = row.pop("delivery_statuses", None)
        row["delivery_status"] = ds[0]["status"] if ds else "pending"
        rows.append(row)
    return rows


def get_total_stats(user_id: str):
    result = (
        _client().table("broadcasts")
        .select("total, sent, not_found, failed")
        .eq("user_id", user_id)
        .eq("status", "done")
        .execute()
    )
    total = sent = not_found = failed = 0
    for r in result.data:
        total += r.get("total") or 0
        sent += r.get("sent") or 0
        not_found += r.get("not_found") or 0
        failed += r.get("failed") or 0
    return {"total": total, "sent": sent, "not_found": not_found, "failed": failed}


# ═══════════════════════════════════════════════════════════════════════════════
# DELIVERY STATUSES
# ═══════════════════════════════════════════════════════════════════════════════

def upsert_delivery_status(message_id, status):
    _client().table("delivery_statuses").upsert(
        {
            "message_id": message_id,
            "status": status,
            "timestamp": datetime.now().isoformat(),
        },
        on_conflict="message_id",
    ).execute()


def get_delivery_statuses_for_broadcast(broadcast_id):
    rec = (
        _client().table("recipients")
        .select("phone, message_id, status")
        .eq("broadcast_id", broadcast_id)
        .execute()
    )
    mids = [r["message_id"] for r in rec.data if r.get("message_id")]
    ds = {}
    if mids:
        ds_result = (
            _client().table("delivery_statuses")
            .select("message_id, status, timestamp")
            .in_("message_id", mids)
            .execute()
        )
        ds = {r["message_id"]: r for r in ds_result.data}
    rows = []
    for r in rec.data:
        row = dict(r)
        d = ds.get(r.get("message_id"))
        row["delivery_status"] = d["status"] if d else "pending"
        row["timestamp"] = d["timestamp"] if d else None
        rows.append(row)
    return rows


# ═══════════════════════════════════════════════════════════════════════════════
# TEMPLATES
# ═══════════════════════════════════════════════════════════════════════════════

def get_templates(user_id: str):
    result = (
        _client().table("templates")
        .select("*")
        .eq("user_id", user_id)
        .order("id", desc=True)
        .execute()
    )
    return result.data


def create_template(user_id: str, name, text):
    result = (
        _client().table("templates")
        .insert({"user_id": user_id, "name": name, "text": text})
        .execute()
    )
    return result.data[0]["id"] if result.data else None


def delete_template(user_id: str, template_id):
    _client().table("templates").delete().eq("id", template_id).eq("user_id", user_id).execute()


# ═══════════════════════════════════════════════════════════════════════════════
# INCOMING
# ═══════════════════════════════════════════════════════════════════════════════

def add_incoming(user_id: str | None, sender, message, msg_type="text", sender_name=None, file_url=None):
    payload = {
        "sender": sender,
        "sender_name": sender_name,
        "message": message,
        "type": msg_type,
        "file_url": file_url,
    }
    if user_id:
        payload["user_id"] = user_id
    _client().table("incoming").insert(payload).execute()


def get_incoming(user_id: str, limit=100):
    result = (
        _client().table("incoming")
        .select("*")
        .eq("user_id", user_id)
        .order("id", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data


def mark_incoming_read(user_id: str, incoming_id):
    _client().table("incoming").update({"is_read": True}).eq("id", incoming_id).eq("user_id", user_id).execute()


def get_unread_count(user_id: str):
    result = (
        _client().table("incoming")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .eq("is_read", False)
        .execute()
    )
    return result.count or 0


# ═══════════════════════════════════════════════════════════════════════════════
# GROUPS
# ═══════════════════════════════════════════════════════════════════════════════

def save_group(user_id: str, group_id, name):
    _client().table("groups").upsert(
        {
            "user_id": user_id,
            "group_id": group_id,
            "name": name,
        },
        on_conflict="user_id,group_id",
    ).execute()


def get_groups(user_id: str):
    result = (
        _client().table("groups")
        .select("*")
        .eq("user_id", user_id)
        .order("id", desc=True)
        .execute()
    )
    return result.data


def delete_group(user_id: str, group_id):
    _client().table("groups").delete().eq("group_id", group_id).eq("user_id", user_id).execute()


def hide_group(user_id: str, group_id):
    _client().table("hidden_groups").upsert(
        {"user_id": user_id, "group_id": group_id},
        on_conflict="user_id,group_id",
    ).execute()


def get_hidden_groups(user_id: str):
    result = (
        _client().table("hidden_groups")
        .select("group_id")
        .eq("user_id", user_id)
        .execute()
    )
    return [r["group_id"] for r in result.data]
