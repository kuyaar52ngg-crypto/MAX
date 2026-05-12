from datetime import datetime
from prisma import Prisma

_prisma = Prisma()
_connected = False


def _db():
    global _connected
    if not _connected:
        _prisma.connect()
        _connected = True
    return _prisma


# ═══════════════════════════════════════════════════════════════════════════════
# CONTACTS CACHE
# ═══════════════════════════════════════════════════════════════════════════════

def get_contacts_cache(user_id: str, chat_ids: list) -> dict:
    if not chat_ids or not user_id:
        return {}
    rows = _db().contactcache.find_many(
        where={"user_id": user_id, "chat_id": {"in": chat_ids}}
    )
    return {
        r.chat_id: {"name": r.name, "avatar_url": r.avatar_url, "updated_at": r.updated_at}
        for r in rows
    }


def upsert_contact_cache(user_id: str, chat_id: str, name: str = None, avatar_url: str = None):
    if not user_id:
        return
    _db().contactcache.upsert(
        where={"user_id_chat_id": {"user_id": user_id, "chat_id": chat_id}},
        data={
            "create": {
                "user_id": user_id,
                "chat_id": chat_id,
                "name": name,
                "avatar_url": avatar_url,
            },
            "update": {"name": name, "avatar_url": avatar_url, "updated_at": datetime.now()},
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# BROADCASTS
# ═══════════════════════════════════════════════════════════════════════════════

def create_broadcast(user_id: str, message, total, file_url=None, file_name=None, use_typing=False):
    record = _db().broadcast.create(
        data={
            "user_id": user_id,
            "message": message,
            "total": total,
            "file_url": file_url,
            "file_name": file_name,
            "use_typing": use_typing,
        }
    )
    return record.id


def update_broadcast_stats(broadcast_id, sent, not_found, failed, status="done"):
    _db().broadcast.update(
        where={"id": broadcast_id},
        data={"sent": sent, "not_found": not_found, "failed": failed, "status": status},
    )


def add_recipient(broadcast_id, phone, status, message_id=None):
    _db().recipient.create(
        data={
            "broadcast_id": broadcast_id,
            "phone": phone,
            "status": status,
            "message_id": message_id,
        }
    )


def get_broadcasts(user_id: str, limit=50):
    rows = _db().broadcast.find_many(
        where={"user_id": user_id}, order={"id": "desc"}, take=limit
    )
    return [r.dict() for r in rows]


def get_broadcast_recipients(broadcast_id):
    rows = _db().recipient.find_many(where={"broadcast_id": broadcast_id})
    mids = [r.message_id for r in rows if r.message_id]
    ds_rows = (
        _db().deliverystatus.find_many(where={"message_id": {"in": mids}})
        if mids else []
    )
    ds_map = {r.message_id: r for r in ds_rows}
    result = []
    for r in rows:
        d = ds_map.get(r.message_id)
        result.append(
            {
                "id": r.id,
                "broadcast_id": r.broadcast_id,
                "phone": r.phone,
                "status": r.status,
                "message_id": r.message_id,
                "sent_at": r.sent_at,
                "delivery_status": d.status if d else "pending",
            }
        )
    return result


def get_total_stats(user_id: str):
    rows = _db().broadcast.find_many(where={"user_id": user_id, "status": "done"})
    total = sent = not_found = failed = 0
    for r in rows:
        total += r.total or 0
        sent += r.sent or 0
        not_found += r.not_found or 0
        failed += r.failed or 0
    return {"total": total, "sent": sent, "not_found": not_found, "failed": failed}


# ═══════════════════════════════════════════════════════════════════════════════
# DELIVERY STATUSES
# ═══════════════════════════════════════════════════════════════════════════════

def upsert_delivery_status(message_id, status):
    _db().deliverystatus.upsert(
        where={"message_id": message_id},
        data={
            "create": {"message_id": message_id, "status": status},
            "update": {"status": status},
        },
    )


def get_delivery_statuses_for_broadcast(broadcast_id):
    rows = _db().recipient.find_many(where={"broadcast_id": broadcast_id})
    mids = [r.message_id for r in rows if r.message_id]
    ds_rows = (
        _db().deliverystatus.find_many(where={"message_id": {"in": mids}})
        if mids else []
    )
    ds_map = {r.message_id: r for r in ds_rows}
    result = []
    for r in rows:
        d = ds_map.get(r.message_id)
        result.append(
            {
                "phone": r.phone,
                "message_id": r.message_id,
                "status": r.status,
                "delivery_status": d.status if d else "pending",
                "timestamp": d.timestamp if d else None,
            }
        )
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# TEMPLATES
# ═══════════════════════════════════════════════════════════════════════════════

def get_templates(user_id: str):
    rows = _db().template.find_many(where={"user_id": user_id}, order={"id": "desc"})
    return [r.dict() for r in rows]


def create_template(user_id: str, name, text):
    record = _db().template.create(data={"user_id": user_id, "name": name, "text": text})
    return record.id


def delete_template(user_id: str, template_id):
    _db().template.delete(where={"id": template_id, "user_id": user_id})


# ═══════════════════════════════════════════════════════════════════════════════
# INCOMING
# ═══════════════════════════════════════════════════════════════════════════════

def add_incoming(user_id: str | None, sender, message, msg_type="text", sender_name=None, file_url=None):
    data = {
        "sender": sender,
        "sender_name": sender_name,
        "message": message,
        "type": msg_type,
        "file_url": file_url,
    }
    if user_id:
        data["user_id"] = user_id
    _db().incoming.create(data=data)


def get_incoming(user_id: str, limit=100):
    rows = _db().incoming.find_many(
        where={"user_id": user_id}, order={"id": "desc"}, take=limit
    )
    return [r.dict() for r in rows]


def mark_incoming_read(user_id: str, incoming_id):
    _db().incoming.update(
        where={"id": incoming_id, "user_id": user_id},
        data={"is_read": True},
    )


def get_unread_count(user_id: str):
    return _db().incoming.count(where={"user_id": user_id, "is_read": False})


# ═══════════════════════════════════════════════════════════════════════════════
# GROUPS
# ═══════════════════════════════════════════════════════════════════════════════

def save_group(user_id: str, group_id, name):
    _db().group.upsert(
        where={"user_id_group_id": {"user_id": user_id, "group_id": group_id}},
        data={
            "create": {"user_id": user_id, "group_id": group_id, "name": name},
            "update": {"name": name},
        },
    )


def get_groups(user_id: str):
    rows = _db().group.find_many(where={"user_id": user_id}, order={"id": "desc"})
    return [r.dict() for r in rows]


def delete_group(user_id: str, group_id):
    _db().group.delete(
        where={"user_id_group_id": {"user_id": user_id, "group_id": group_id}}
    )


def hide_group(user_id: str, group_id):
    _db().hiddengroup.upsert(
        where={"user_id_group_id": {"user_id": user_id, "group_id": group_id}},
        data={
            "create": {"user_id": user_id, "group_id": group_id},
            "update": {},
        },
    )


def get_hidden_groups(user_id: str):
    rows = _db().hiddengroup.find_many(where={"user_id": user_id})
    return [r.group_id for r in rows]
