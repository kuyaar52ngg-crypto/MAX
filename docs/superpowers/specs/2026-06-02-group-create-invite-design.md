# Group Create & Invite — Design Spec

## Goal
Add the ability to create WhatsApp groups and mass-invite participants from the Messenger tab, using manual input, CSV upload, and contact segments.

## Context
- Messenger page (`/dashboard/messenger`) shows chat list with "All / Chats / Groups" tabs
- `GroupSettingsPanel` already manages existing groups (rename, avatar, add/remove single participant, admin toggle, leave)
- Backend endpoints already exist: `POST /api/create-group`, `POST /api/group/<id>/add-bulk`, `POST /api/upload-contacts`
- `SegmentLoader` component already provides segment picker logic (load from segment, save as segment)

## Design

### 1. CreateGroupModal

**Trigger:** `Plus` icon button in the chat sidebar header (next to "Чаты" title).

**Form fields:**
- Group name (required, text input)
- Participants section with 3 input modes:
  - Manual input: textarea for phone numbers (comma/space/newline separated)
  - CSV upload: file input `.csv`, parsed client-side extracting `phone` column, then sent as phones array
  - From segment: reuse `SegmentLoader` to pick a segment and load its members
- Aggregated phone list: all numbers from all sources shown as removable chips
- Welcome message (optional, text input)
- "Create group" button

**On success:**
- Show toast with group ID, member count, not-found count
- Refresh chat list (`loadChats`)
- Auto-open the newly created group chat

**API:** `POST /api/create-group` — `{ name, phones: string[], message }`

### 2. InviteModal

**Trigger:** `UserPlus` button in `GroupSettingsPanel` (alongside the existing single-participant add field).

**Form fields:**
- Same 3 input modes as CreateGroupModal: manual, CSV, segment
- Aggregated phone list with removable chips
- "Invite" button
- Results display: per-phone success/not-found status

**API:** `POST /api/group/<group_id>/add-bulk` — `{ phones: string[] }`

**On success:**
- Refresh group data in panel
- Show results summary (X added, Y not found)

### 3. MessengerPage changes

- Add `Plus` icon button in sidebar header row
- State: `showCreateModal` boolean
- Render `CreateGroupModal` when true
- On group created: call `loadChats()`, find new group in list, `openChat(newGroup)`

### 4. GroupSettingsPanel changes

- Keep existing single-participant add field (quick add)
- Add `UserPlus` button labeled "Массовый инвайт" below the single-add field
- State: `showInviteModal` boolean
- Render `InviteModal` when true, passing `groupId`

### 5. Backend

No changes needed. All endpoints exist:
- `POST /api/create-group` — creates group, adds participants, optionally sends welcome message
- `POST /api/group/<group_id>/add-bulk` — bulk adds participants by phone numbers
- `POST /api/upload-contacts` — CSV parsing (returns phones array)

## Components to create

1. **`CreateGroupModal`** — full modal with form, uses `apiPost("/api/create-group")`
2. **`InviteModal`** — modal with form, uses `apiPost("/api/group/<id>/add-bulk")`
3. **`PhoneCollector`** — shared sub-component for the 3-input-mode phone collection UI (manual, CSV, segment). Used by both modals.

## File changes summary

| File | Change |
|------|--------|
| `frontend/src/components/CreateGroupModal.tsx` | New — create group modal |
| `frontend/src/components/InviteModal.tsx` | New — bulk invite modal |
| `frontend/src/components/PhoneCollector.tsx` | New — shared phone input block |
| `frontend/src/app/dashboard/messenger/page.tsx` | Add Plus button + CreateGroupModal |
| `frontend/src/components/GroupSettingsPanel.tsx` | Add Invite button + InviteModal |
