"""Планировщик рассылок: фоновый поток, обрабатывающий
``scheduled_broadcasts`` в Supabase Postgres.

Архитектура:
  - Frontend (Next.js + Prisma) пишет в таблицу ``scheduled_broadcasts``
    через UI (создание / пауза / отмена / редактирование).
  - Этот модуль раз в 15 секунд опрашивает Postgres напрямую через
    ``psycopg2`` и забирает строки, у которых ``next_run_at <= now()``
    при ``status IN ('scheduled', 'running')``.
  - Для каждой due-задачи проверяет тихие часы и таймзоны, и затем
    запускает рассылку через ту же машинерию, что и обычный
    ``/api/broadcast`` endpoint (``_run_broadcast_worker``).

Поддерживаемые типы расписания:
  * ``once``      — однократно в указанное время.
  * ``drip``      — рассылка дробится на волны по N контактов с
                    интервалом, чтобы снизить риск бана и распределить
                    нагрузку. После каждой волны планировщик сам
                    переставляет ``next_run_at``.
  * ``recurring`` — daily / weekly / monthly с временем в ``user_tz``.
                    Расписание продолжается до ``recurring_until``.

Флаг ``quiet_hours_enabled`` сдвигает старт за пределы окна тишины.
``respect_recipient_tz`` использует phone country-code → IANA tz
mapping (``timezones_helper.phone_to_tz``); если у получателя в
текущий момент тишина, его контакт откладывается на следующий
запуск (для once эта логика недоступна — там либо отправляем всем,
либо сдвигаем целиком).
"""

import json
import logging
import os
import threading
import time
from contextlib import closing
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo

import psycopg2
import psycopg2.extras

from anti_ban.config_loader import config_loader
from anti_ban.audit import audit_logger
from anti_ban.rate_limiter import RateLimiter
from anti_ban.registry import RunHandle, registry  # noqa: F401  (используется в _run_broadcast)
from bot import MaxBot

logger = logging.getLogger(__name__)

# Период polling-а, в секундах. Чем меньше — тем точнее срабатывает
# ``scheduled_for``; 15 сек — компромисс между точностью и нагрузкой.
POLL_INTERVAL_SECONDS = 15

DATABASE_URL_ENV = "DATABASE_URL"


# ───────────────────────── Country-code → IANA tz ──────────────────────────
#
# Грубое сопоставление кода страны (из E.164) к таймзоне. Используется
# при ``respect_recipient_tz=True`` для определения, у кого сейчас
# тихие часы. Не претендует на точность для стран с несколькими тз
# (USA / Россия / Австралия) — берём «столичную» / самую населённую.
# Когда нужна точность — добавим библиотеку ``phonenumbers``.

_COUNTRY_CODE_TO_TZ: list[tuple[str, str]] = [
    # Длинные коды должны идти первыми, чтобы не перепутать +1 и +1242.
    ("995",  "Asia/Tbilisi"),
    ("994",  "Asia/Baku"),
    ("992",  "Asia/Dushanbe"),
    ("380",  "Europe/Kyiv"),
    ("375",  "Europe/Minsk"),
    ("373",  "Europe/Chisinau"),
    ("371",  "Europe/Riga"),
    ("370",  "Europe/Vilnius"),
    ("372",  "Europe/Tallinn"),
    ("48",   "Europe/Warsaw"),
    ("49",   "Europe/Berlin"),
    ("44",   "Europe/London"),
    ("33",   "Europe/Paris"),
    ("39",   "Europe/Rome"),
    ("34",   "Europe/Madrid"),
    ("31",   "Europe/Amsterdam"),
    ("30",   "Europe/Athens"),
    ("90",   "Europe/Istanbul"),
    ("420",  "Europe/Prague"),
    ("421",  "Europe/Bratislava"),
    ("36",   "Europe/Budapest"),
    ("40",   "Europe/Bucharest"),
    ("385",  "Europe/Zagreb"),
    ("389",  "Europe/Skopje"),
    ("381",  "Europe/Belgrade"),
    ("382",  "Europe/Podgorica"),
    ("7",    "Europe/Moscow"),
    ("86",   "Asia/Shanghai"),
    ("81",   "Asia/Tokyo"),
    ("82",   "Asia/Seoul"),
    ("84",   "Asia/Ho_Chi_Minh"),
    ("66",   "Asia/Bangkok"),
    ("60",   "Asia/Kuala_Lumpur"),
    ("65",   "Asia/Singapore"),
    ("62",   "Asia/Jakarta"),
    ("63",   "Asia/Manila"),
    ("91",   "Asia/Kolkata"),
    ("92",   "Asia/Karachi"),
    ("971",  "Asia/Dubai"),
    ("972",  "Asia/Jerusalem"),
    ("961",  "Asia/Beirut"),
    ("966",  "Asia/Riyadh"),
    ("20",   "Africa/Cairo"),
    ("27",   "Africa/Johannesburg"),
    ("234",  "Africa/Lagos"),
    ("254",  "Africa/Nairobi"),
    ("212",  "Africa/Casablanca"),
    ("213",  "Africa/Algiers"),
    ("216",  "Africa/Tunis"),
    ("55",   "America/Sao_Paulo"),
    ("54",   "America/Argentina/Buenos_Aires"),
    ("56",   "America/Santiago"),
    ("52",   "America/Mexico_City"),
    ("57",   "America/Bogota"),
    ("58",   "America/Caracas"),
    ("51",   "America/Lima"),
    ("1",    "America/New_York"),  # USA/Canada — берём eastern
    ("61",   "Australia/Sydney"),
    ("64",   "Pacific/Auckland"),
]


def _digits(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def phone_to_tz(phone: str) -> Optional[str]:
    """Возвращает IANA timezone для телефона по country code.

    Возвращает ``None``, если страна не определена.
    """
    digits = _digits(phone)
    if not digits:
        return None
    for code, tz_name in _COUNTRY_CODE_TO_TZ:
        if digits.startswith(code):
            return tz_name
    return None


# ───────────────────────── Quiet hours helpers ─────────────────────────────


def is_in_quiet_hours(now: datetime, start_h: int, end_h: int) -> bool:
    """True, если ``now.hour`` попадает в окно [start_h, end_h)."""
    if start_h == end_h:
        return False
    h = now.hour
    if start_h < end_h:
        return start_h <= h < end_h
    # Окно через полночь (например, 22:00–08:00)
    return h >= start_h or h < end_h


def shift_out_of_quiet(now: datetime, start_h: int, end_h: int) -> datetime:
    """Сдвинуть ``now`` на ближайший конец окна тишины (в той же tz)."""
    if not is_in_quiet_hours(now, start_h, end_h):
        return now
    candidate = now.replace(hour=end_h, minute=0, second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


# ───────────────────────── Recurring next-run helpers ──────────────────────


def compute_next_recurring_run(
    *,
    kind: str,
    hour: int,
    minute: int,
    day_of_week: Optional[int],
    day_of_month: Optional[int],
    user_tz: str,
    after: datetime,
) -> Optional[datetime]:
    """Следующее время срабатывания для daily/weekly/monthly после ``after``.

    Все вычисления — в ``user_tz``. Возвращает datetime в UTC.
    """
    try:
        tz = ZoneInfo(user_tz)
    except Exception:
        tz = ZoneInfo("UTC")

    after_local = after.astimezone(tz)
    base = after_local.replace(
        hour=hour, minute=minute, second=0, microsecond=0,
    )

    if kind == "daily":
        candidate = base
        if candidate <= after_local:
            candidate += timedelta(days=1)
    elif kind == "weekly":
        if day_of_week is None:
            return None
        # Python: Monday=0 .. Sunday=6
        delta_days = (day_of_week - base.weekday()) % 7
        candidate = base + timedelta(days=delta_days)
        if candidate <= after_local:
            candidate += timedelta(days=7)
    elif kind == "monthly":
        if day_of_month is None:
            return None
        candidate = base.replace(day=min(day_of_month, 28))
        if candidate <= after_local:
            # Шаг на следующий месяц
            year = candidate.year + (candidate.month // 12)
            month = (candidate.month % 12) + 1
            candidate = candidate.replace(
                year=year, month=month, day=min(day_of_month, 28),
            )
    else:
        return None

    return candidate.astimezone(timezone.utc)


# ───────────────────────── Postgres helpers ────────────────────────────────


def _get_database_url() -> Optional[str]:
    return os.getenv(DATABASE_URL_ENV)


def _connect():
    url = _get_database_url()
    if not url:
        raise RuntimeError(
            f"{DATABASE_URL_ENV} не задан — планировщик рассылок отключён"
        )
    return psycopg2.connect(url)


def _row_to_dict(row) -> dict:
    return dict(row) if row is not None else {}


# ───────────────────────── Scheduler thread ────────────────────────────────


class BroadcastScheduler:
    """Singleton фоновый поток, обрабатывающий due-задачи раз в 15 сек."""

    def __init__(self):
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._started = False
        self._lock = threading.Lock()

    def start(self):
        with self._lock:
            if self._started:
                return
            if not _get_database_url():
                logger.warning(
                    "BroadcastScheduler не стартует: %s не задан",
                    DATABASE_URL_ENV,
                )
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run, name="broadcast-scheduler", daemon=True,
            )
            self._thread.start()
            self._started = True
            logger.info("BroadcastScheduler started")

    def stop(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5.0)
        self._started = False

    # ─────────────────────────── Main loop ─────────────────────────────────

    def _run(self):
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception:
                logger.exception("BroadcastScheduler tick failed")
            self._stop_event.wait(POLL_INTERVAL_SECONDS)

    def _tick(self):
        due = self._fetch_due_jobs()
        for job in due:
            try:
                self._process_job(job)
            except Exception as exc:
                logger.exception(
                    "scheduled_broadcast id=%s: ошибка обработки",
                    job.get("id"),
                )
                self._mark_failed(job["id"], str(exc))

        # ── Schedule_Mode_Engine dispatch (broadcast-scheduling-suite, Task 6.11)
        #
        # После обработки «старых» режимов (``once`` / ``drip`` /
        # ``recurring``) этим scheduler'ом, делегируем «новые» режимы
        # (``window`` / ``smart_time`` / ``ab_time`` / ``burst``) в
        # ``ScheduleModeEngine``. Тот сам делает свой SELECT с
        # фильтром ``schedule_type IN (...)`` и ``approval_status !=
        # 'pending'`` (Req 7.4).
        #
        # Late-import ``app``: модуль ``app`` импортирует ``scheduler``,
        # поэтому импорт делаем внутри метода, а не на уровне модуля.
        # Защитный try/except: ошибка нового движка НЕ должна валить
        # старый ``BroadcastScheduler`` — он обслуживает legacy-задачи
        # и должен оставаться надёжным независимо от состояния
        # suite-кода (Req 8.1, fail-safe).
        try:
            import app as _app  # late import: avoid circular dependency

            engine = getattr(_app, "schedule_mode_engine", None)
            if engine is not None:
                engine.dispatch_due()
        except Exception:
            logger.exception(
                "Schedule_Mode_Engine.dispatch_due() failed — legacy "
                "BroadcastScheduler tick continues normally"
            )

    # ─────────────────────────── DB queries ────────────────────────────────

    def _fetch_due_jobs(self) -> list[dict]:
        with closing(_connect()) as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT * FROM scheduled_broadcasts
                    WHERE status IN ('scheduled', 'running')
                      AND next_run_at IS NOT NULL
                      AND next_run_at <= NOW()
                    ORDER BY next_run_at ASC
                    LIMIT 50
                    """,
                )
                return [dict(r) for r in cur.fetchall()]

    def _update_job(self, job_id: int, fields: dict):
        if not fields:
            return
        keys = list(fields.keys())
        set_clause = ", ".join(f'"{k}" = %s' for k in keys)
        values = [fields[k] for k in keys]
        values.append(job_id)
        with closing(_connect()) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    f'UPDATE scheduled_broadcasts SET {set_clause}, "updated_at" = NOW() '
                    f'WHERE id = %s',
                    values,
                )
            conn.commit()

    def _mark_failed(self, job_id: int, error: str):
        self._update_job(job_id, {
            "status": "failed",
            "last_error": error[:500],
            "last_run_at": datetime.now(timezone.utc),
        })

    # ─────────────────────────── Job processing ────────────────────────────

    def _process_job(self, job: dict):
        job_id = job["id"]
        schedule_type = job["schedule_type"]
        user_tz_name = job.get("user_tz") or "UTC"
        try:
            user_tz = ZoneInfo(user_tz_name)
        except Exception:
            user_tz = ZoneInfo("UTC")
        now_utc = datetime.now(timezone.utc)
        now_local = now_utc.astimezone(user_tz)

        # ── Quiet hours: сдвигаем next_run_at, не запускаем сейчас ─────
        if job.get("quiet_hours_enabled"):
            qh_start = int(job.get("quiet_hours_start") or 22)
            qh_end = int(job.get("quiet_hours_end") or 8)
            if is_in_quiet_hours(now_local, qh_start, qh_end):
                shifted_local = shift_out_of_quiet(now_local, qh_start, qh_end)
                shifted_utc = shifted_local.astimezone(timezone.utc)
                logger.info(
                    "scheduled_broadcast id=%s: quiet hours — отложено до %s",
                    job_id, shifted_utc.isoformat(),
                )
                self._update_job(job_id, {"next_run_at": shifted_utc})
                return

        # ── Контакты + опциональная фильтрация по recipient tz ─────────
        contacts_raw = job.get("contacts") or []
        if isinstance(contacts_raw, str):
            try:
                contacts_raw = json.loads(contacts_raw)
            except json.JSONDecodeError:
                contacts_raw = []

        contacts, deferred_contacts = self._partition_by_recipient_tz(
            contacts_raw, job, now_utc,
        )

        if not contacts and deferred_contacts:
            # Все получатели в тишине — отложить на час и пересчитать.
            self._update_job(job_id, {
                "next_run_at": now_utc + timedelta(hours=1),
            })
            return

        # ── Drip: берём только batch ───────────────────────────────────
        wave_index = int(job.get("drip_wave_index") or 0)
        drip_batch = job.get("drip_batch_size")
        drip_total_waves = None
        if schedule_type == "drip" and drip_batch:
            start = wave_index * int(drip_batch)
            end = start + int(drip_batch)
            slice_to_send = contacts[start:end]
            drip_total_waves = (len(contacts) + int(drip_batch) - 1) // int(drip_batch)
            if not slice_to_send:
                # Все волны отправлены
                self._update_job(job_id, {
                    "status": "done",
                    "last_run_at": now_utc,
                    "next_run_at": None,
                })
                return
            contacts_to_send = slice_to_send
        else:
            contacts_to_send = contacts

        if not contacts_to_send:
            # Нет получателей — закрываем как done.
            self._update_job(job_id, {
                "status": "done",
                "last_run_at": now_utc,
                "next_run_at": None,
            })
            return

        # ── Запуск рассылки ────────────────────────────────────────────
        self._update_job(job_id, {
            "status": "running",
            "last_run_at": now_utc,
            "runs_count": int(job.get("runs_count") or 0) + 1,
            "last_error": None,
        })

        try:
            self._run_broadcast(job, contacts_to_send)
        except Exception as exc:
            logger.exception("scheduled_broadcast id=%s: рассылка упала", job_id)
            self._mark_failed(job_id, str(exc))
            return

        # ── Перепланирование ───────────────────────────────────────────
        update: dict[str, Any] = {"last_run_at": now_utc, "last_error": None}

        if schedule_type == "once":
            update["status"] = "done"
            update["next_run_at"] = None
        elif schedule_type == "drip":
            update["drip_wave_index"] = wave_index + 1
            interval = int(job.get("drip_interval_minutes") or 30)
            next_at = now_utc + timedelta(minutes=interval)
            # Если все волны отправлены — закроем.
            if drip_total_waves is not None and wave_index + 1 >= drip_total_waves:
                update["status"] = "done"
                update["next_run_at"] = None
            else:
                update["status"] = "scheduled"
                update["next_run_at"] = next_at
        elif schedule_type == "recurring":
            kind = job.get("recurring_kind") or "daily"
            hour = int(job.get("recurring_hour") or 10)
            minute = int(job.get("recurring_minute") or 0)
            dow = job.get("recurring_day_of_week")
            dom = job.get("recurring_day_of_month")
            until = job.get("recurring_until")
            next_local_utc = compute_next_recurring_run(
                kind=kind, hour=hour, minute=minute,
                day_of_week=dow, day_of_month=dom,
                user_tz=user_tz_name, after=now_utc,
            )
            if next_local_utc is None or (until and next_local_utc > until):
                update["status"] = "done"
                update["next_run_at"] = None
            else:
                update["status"] = "scheduled"
                update["next_run_at"] = next_local_utc
        else:
            update["status"] = "done"
            update["next_run_at"] = None

        self._update_job(job_id, update)

    def _partition_by_recipient_tz(
        self, contacts: list, job: dict, now_utc: datetime,
    ) -> tuple[list, list]:
        """Возвращает (sendable, deferred). Если ``respect_recipient_tz``
        выключен — все sendable."""
        if not job.get("respect_recipient_tz") or not job.get("quiet_hours_enabled"):
            return list(contacts), []
        qh_start = int(job.get("quiet_hours_start") or 22)
        qh_end = int(job.get("quiet_hours_end") or 8)
        sendable: list = []
        deferred: list = []
        for contact in contacts:
            phone = (
                contact.get("phone") if isinstance(contact, dict) else str(contact)
            )
            tz_name = phone_to_tz(phone or "")
            if not tz_name:
                # Неизвестная страна — оставляем sendable.
                sendable.append(contact)
                continue
            try:
                tz = ZoneInfo(tz_name)
            except Exception:
                sendable.append(contact)
                continue
            local = now_utc.astimezone(tz)
            if is_in_quiet_hours(local, qh_start, qh_end):
                deferred.append(contact)
            else:
                sendable.append(contact)
        return sendable, deferred

    # ─────────────────────────── Broadcast launch ──────────────────────────

    def _run_broadcast(self, job: dict, contacts: list):
        """Запустить рассылку через тот же worker, что и /api/broadcast.

        Если в процессе уже идёт ручная рассылка (``_broadcast_active``),
        откладываем эту задачу на 5 минут, чтобы не плодить конкурирующие
        worker'ы — глобальный флаг защищает от двойного запуска
        (см. ``app.api_broadcast``).
        """
        import app  # late import: избегаем цикла

        if getattr(app, "_broadcast_active", False):
            logger.info(
                "scheduled_broadcast id=%s: уже идёт другая рассылка, откладываем",
                job.get("id"),
            )
            self._update_job(int(job["id"]), {
                "next_run_at": datetime.now(timezone.utc) + timedelta(minutes=5),
                "status": "scheduled",
            })
            return

        user_id = (job.get("bot_id_instance") or "").strip() or "unknown"
        config = config_loader.get(user_id)
        rate_limiter = RateLimiter(config)

        # Применяем personalized_messages, если есть
        personalized = job.get("personalized_messages") or {}
        if isinstance(personalized, str):
            try:
                personalized = json.loads(personalized)
            except json.JSONDecodeError:
                personalized = {}
        if personalized:
            contacts = [
                {**c, "_message": personalized[c["phone"]]} if (
                    isinstance(c, dict) and c.get("phone") in personalized
                ) else c
                for c in contacts
            ]

        # Bot factory: используем сохранённые credentials.
        id_inst = (job.get("bot_id_instance") or "").strip()
        api_token = (job.get("bot_api_token") or "").strip()
        api_url = (
            job.get("bot_api_url") or "https://api.green-api.com"
        ).rstrip("/")
        if not id_inst or not api_token:
            raise RuntimeError("scheduled_broadcast: нет GREEN-API credentials")
        bot = MaxBot(id_inst, api_token)
        bot.base_url = f"{api_url}/waInstance{id_inst}"

        message = job.get("message") or ""
        delay = float(job.get("delay_seconds") or 3.0)
        use_typing = bool(job.get("use_typing"))
        file_url = job.get("file_url")
        file_name = job.get("file_name")

        # Создаём OperationRun + регистрируем в registry.
        run_id = audit_logger.start_run(
            user_id=user_id,
            kind="broadcast",
            total=len(contacts),
            payload={
                "contacts": contacts,
                "params": {
                    "message_template": message,
                    "use_typing": use_typing,
                    "delay": delay,
                    "scheduled_broadcast_id": int(job["id"]),
                    "schedule_type": job.get("schedule_type"),
                },
            },
        )
        cancel_event = threading.Event()
        handle = RunHandle(
            run_id=run_id,
            cancel_event=cancel_event,
            last_progress_at=time.time(),
            kind="broadcast",
            global_flag_name=None,  # запуск из планировщика не трогает _broadcast_active
        )
        registry.register(run_id, handle)

        # Активируем глобальный флаг, как это делает API endpoint.
        # _run_broadcast_worker сбросит его в finally.
        app._broadcast_active = True

        # Synchronous call — мы и так в фоновом потоке планировщика,
        # отдельный thread не нужен. _run_broadcast_worker сам
        # финализирует OperationRun в finally.
        #
        # ``schedule_type`` (broadcast-scheduling-suite Req 8.x):
        # пробрасываем напрямую из job. Для legacy-режимов (``once``,
        # ``drip``, ``recurring``) worker увидит ``schedule_type !=
        # "burst"`` и пойдёт обычной anti-ban-веткой. Для ``burst``
        # worker включит burst-pacing через BurstEngine.delay_for.
        app._run_broadcast_worker(
            run_id=run_id,
            contacts=contacts,
            message=message,
            user_delay=delay,
            use_typing=use_typing,
            broadcast_id=int(job["id"]),
            is_multipart=False,
            uploaded_path=None,
            uploaded_name=None,
            file_url=file_url,
            file_name=file_name,
            user_id=user_id,
            cancel_event=cancel_event,
            rate_limiter=rate_limiter,
            config=config,
            bot_instance=bot,
            schedule_type=str(job.get("schedule_type") or "") or None,
        )


# Singleton
scheduler = BroadcastScheduler()
