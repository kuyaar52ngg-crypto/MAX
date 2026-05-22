# Implementation Plan: Enhanced Broadcast Scheduling

## Overview

This implementation plan covers three major areas: improved anti-ban settings UX (scenario cards, risk indicators, timeline simulation), external GREEN API instance management (connection wizard, multi-instance support), and advanced broadcast scheduling (follow-up chains, A/B testing, adaptive throttle, calendar exceptions, schedule templates). Tasks are ordered to build foundational data models first, then backend logic, then frontend components, with integration wiring at the end.

## Tasks

- [x] 1. Database schema and Prisma models
  - [x] 1.1 Create Prisma migration for new models (GreenInstance, FollowUpChain, FollowUpRecipient, ABTest, ABTestRecipient, CalendarException, ScheduleTemplate)
    - Add all models defined in the design document to `frontend/prisma/schema.prisma`
    - Create migration SQL for all new tables with indexes and constraints
    - Add fields `instance_id`, `adaptive_throttle`, `follow_up_chain_id`, `ab_test_id` to existing `ScheduledBroadcast` model
    - _Requirements: 4.1, 5.5, 6.5, 8.4, 9.4_

  - [x] 1.2 Add encryption utility for GreenInstance api_token
    - Create `frontend/src/lib/encryption.ts` with AES-256-GCM encrypt/decrypt functions
    - Use `INSTANCE_ENCRYPTION_KEY` env variable (32 bytes, base64)
    - Storage format: `iv:ciphertext:tag` (base64)
    - Return HTTP 503 if encryption key is not configured
    - _Requirements: 3.6_

- [ ] 2. GREEN API Instance Management (Backend API)
  - [-] 2.1 Implement `/api/green-instances` CRUD API routes
    - GET: list user's instances with decrypted status
    - POST: create new instance (validate limit of 5, encrypt token, call getStateInstance)
    - PUT `[id]`: update name, is_primary
    - DELETE `[id]`: remove instance
    - _Requirements: 4.1, 4.5, 3.2, 3.6_

  - [ ]* 2.2 Write property test for instance limit enforcement (Property 5)
    - **Property 5: Instance limit enforcement**
    - **Validates: Requirements 4.5**

  - [ ]* 2.3 Write property test for unhealthy instance blocking broadcast (Property 6)
    - **Property 6: Unhealthy instance blocks broadcast**
    - **Validates: Requirements 4.4**

  - [ ]* 2.4 Write property test for broadcast using selected instance credentials (Property 20)
    - **Property 20: Broadcast uses selected instance credentials**
    - **Validates: Requirements 4.3**

- [ ] 3. Follow-Up Chains (Backend API + Flask)
  - [-] 3.1 Implement `/api/follow-up-chains` CRUD API routes
    - POST: create chain with steps validation (1-5 steps, required fields)
    - GET: list chains for user with progress stats
    - PUT `[id]`: update chain status (cancel)
    - Validate FollowUpStep JSON schema (step_index, message, condition_type, condition_hours)
    - Return HTTP 422 for invalid payloads
    - _Requirements: 5.1, 5.2, 5.5, 10.1, 10.4_

  - [~] 3.2 Implement `follow_up_processor.py` in Flask backend
    - Create `FollowUpProcessor` class with `evaluate_triggers`, `check_recipient_replied`, `schedule_next_step` methods
    - Integrate with scheduler tick (every 15s)
    - Check condition triggers: `no_reply`, `read_no_reply`, `time_elapsed`
    - Stop chain for recipient on reply (set status to "exited")
    - Respect quiet hours and anti-ban settings when scheduling
    - _Requirements: 5.2, 5.3, 5.4_

  - [ ]* 3.3 Write property test for follow-up chain step count validation (Property 7)
    - **Property 7: Follow-up chain step count validation**
    - **Validates: Requirements 5.1**

  - [ ]* 3.4 Write property test for follow-up chain stops on reply (Property 8)
    - **Property 8: Follow-up chain stops on reply**
    - **Validates: Requirements 5.4**

  - [ ]* 3.5 Write property test for follow-up steps round-trip serialization (Property 9)
    - **Property 9: Follow-up steps round-trip serialization**
    - **Validates: Requirements 10.1, 10.2, 10.3**

  - [ ]* 3.6 Write property test for follow-up steps validation rejects invalid payloads (Property 10)
    - **Property 10: Follow-up steps validation rejects invalid payloads**
    - **Validates: Requirements 10.4**

- [ ] 4. A/B Testing (Backend API + Flask)
  - [~] 4.1 Implement `/api/ab-tests` CRUD API routes
    - POST: create A/B test (validate 2-4 variants, test_percentage 10-50)
    - GET: list tests with metrics
    - PUT `[id]`: select winner variant, cancel test
    - _Requirements: 6.1, 6.2, 6.5_

  - [~] 4.2 Implement `ab_test_processor.py` in Flask backend
    - Create `ABTestProcessor` class with `distribute_recipients`, `compute_variant_metrics`, `schedule_winner` methods
    - Use deterministic shuffle (seeded random by broadcast_id) for reproducible distribution
    - Compute delivery%, read%, reply% for each variant
    - Schedule winner variant to remaining recipients
    - Integrate with scheduler tick for completion check
    - _Requirements: 6.2, 6.3, 6.4_

  - [ ]* 4.3 Write property test for A/B test variant count validation (Property 11)
    - **Property 11: A/B test variant count validation**
    - **Validates: Requirements 6.1**

  - [ ]* 4.4 Write property test for A/B test recipient distribution (Property 12)
    - **Property 12: A/B test recipient distribution**
    - **Validates: Requirements 6.2**

  - [ ]* 4.5 Write property test for A/B test metrics computation (Property 13)
    - **Property 13: A/B test metrics computation**
    - **Validates: Requirements 6.3**

  - [ ]* 4.6 Write property test for A/B test winner scheduling (Property 14)
    - **Property 14: A/B test winner scheduling**
    - **Validates: Requirements 6.4**

- [ ] 5. Adaptive Throttle (Flask)
  - [~] 5.1 Implement `adaptive_throttle.py` module
    - Create `ThrottleState` dataclass and `AdaptiveThrottle` class
    - Implement state machine: normal → slowed (score < 80%), slowed → normal (score > 95%), slowed → paused (score < 50%)
    - Compute Delivery_Score every 20 messages
    - Increase delay by 50% on slowdown, restore to base on recovery
    - Log `throttle_slowdown`, `throttle_restored` incidents
    - Pause broadcast and notify user when score < 50%
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [~] 5.2 Integrate Adaptive Throttle into Broadcast Worker
    - Modify broadcast worker to use `AdaptiveThrottle` when `adaptive_throttle=True` on ScheduledBroadcast
    - Route messages through selected GreenInstance credentials (multi-instance support)
    - Record delivery results and evaluate throttle after every 20 messages
    - _Requirements: 7.5, 7.6, 4.3_

  - [ ]* 5.3 Write property test for adaptive throttle state transitions (Property 15)
    - **Property 15: Adaptive throttle state transitions**
    - **Validates: Requirements 7.2, 7.3, 7.4**

  - [ ]* 5.4 Write property test for adaptive throttle delay adjustment (Property 16)
    - **Property 16: Adaptive throttle delay adjustment**
    - **Validates: Requirements 7.1, 7.2, 7.3**

- [ ] 6. Calendar Exceptions (Backend API + Flask)
  - [-] 6.1 Implement `/api/calendar-exceptions` CRUD API routes
    - POST: create exception (single date, range, or recurring)
    - GET: list exceptions for user
    - DELETE `[id]`: remove exception
    - Validate end_date >= start_date
    - _Requirements: 8.1, 8.2, 8.4_

  - [~] 6.2 Implement `calendar_exception_checker.py` in Flask backend
    - Create `is_date_in_exception(dt, exceptions)` pure function
    - Handle recurring types: weekly (day_of_week), monthly (day_of_month), yearly (month+day)
    - Create `compute_next_valid_run(original_run_at, exceptions)` function
    - Limit postponement to max 30 days (fail-safe)
    - Integrate with scheduler tick to check before launching broadcasts
    - _Requirements: 8.3, 8.5_

  - [ ]* 6.3 Write property test for calendar exception overlap detection (Property 17)
    - **Property 17: Calendar exception overlap detection**
    - **Validates: Requirements 8.3, 8.5**

  - [ ]* 6.4 Write property test for calendar exception postpones broadcast (Property 18)
    - **Property 18: Calendar exception postpones broadcast**
    - **Validates: Requirements 8.3**

- [ ] 7. Schedule Templates (Backend API)
  - [-] 7.1 Implement `/api/schedule-templates` CRUD API routes
    - POST: create template (validate non-empty name, valid config JSON)
    - GET: list templates for user
    - PUT `[id]`: rename template
    - DELETE `[id]`: remove template
    - _Requirements: 9.1, 9.2, 9.4, 9.5_

  - [ ]* 7.2 Write property test for schedule template round-trip (Property 19)
    - **Property 19: Schedule template round-trip**
    - **Validates: Requirements 9.2**

- [~] 8. Checkpoint - Backend complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Anti-Ban Settings UX (Frontend)
  - [~] 9.1 Implement `ScenarioCard` component and scenario presets
    - Create `ScenarioCard` component with three presets: small (до 100), medium (100-500), large (500+)
    - Each preset auto-fills all AntiBanConfig fields with optimal values
    - Show visual confirmation when a scenario is applied
    - Allow switching to manual mode for advanced users
    - _Requirements: 1.1, 1.2_

  - [~] 9.2 Implement `RiskIndicator` component and `computeRiskLevel` function
    - Create `computeRiskLevel(param, value)` pure function with hardcoded thresholds
    - Display colored indicator (green/yellow/red) next to each parameter field
    - Update within 200ms on any parameter change (synchronous computation)
    - _Requirements: 1.3, 1.4_

  - [~] 9.3 Implement `TimelineSimulation` component and `simulateTimeline` function
    - Create `simulateTimeline(config, count=10)` deterministic function returning TimelineEvent[]
    - Render visual timeline showing pauses, batches, and long pauses
    - Show tooltip on hover explaining each pause and responsible parameter
    - _Requirements: 2.1, 2.2_

  - [~] 9.4 Implement `MetricsPanel` component and `computeSettingsMetrics` function
    - Create `computeSettingsMetrics(config)` function computing timeFor100, timeFor500, safetyLevel
    - Display three metrics in a summary panel
    - Update within 300ms on any parameter change
    - _Requirements: 2.3, 2.4_

  - [ ]* 9.5 Write property test for scenario card config application (Property 1)
    - **Property 1: Scenario card applies correct config**
    - **Validates: Requirements 1.2**

  - [ ]* 9.6 Write property test for risk indicator correctness (Property 2)
    - **Property 2: Risk indicator correctness**
    - **Validates: Requirements 1.3**

  - [ ]* 9.7 Write property test for timeline simulation consistency (Property 3)
    - **Property 3: Timeline simulation consistency**
    - **Validates: Requirements 2.1, 2.3**

  - [ ]* 9.8 Write property test for settings metrics formula correctness (Property 4)
    - **Property 4: Settings metrics formula correctness**
    - **Validates: Requirements 2.3, 2.4**

- [ ] 10. Instance Connection Wizard (Frontend)
  - [~] 10.1 Implement `InstanceConnectionWizard` component
    - Create multi-step wizard: credentials → checking → qr → success/error
    - Input fields for `idInstance` and `apiTokenInstance`
    - Call `/api/green-instances` POST to validate and save
    - Display QR code step when instance status is `notAuthorized`
    - Show success screen with phone number when `authorized`
    - Show error message for invalid credentials
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [~] 10.2 Implement `MultiInstanceSelector` component
    - Create dropdown/selector showing all connected instances with status indicators
    - Display on broadcast and scheduled broadcast pages
    - Block broadcast start if selected instance is blocked/notAuthorized
    - _Requirements: 4.2, 4.3, 4.4_

- [ ] 11. Follow-Up Chain Builder (Frontend)
  - [~] 11.1 Implement `FollowUpChainBuilder` UI component
    - Create step-by-step builder for 1-5 follow-up messages
    - Each step: message text, condition trigger selector, condition hours input, optional file URL
    - Condition types: "не ответил в течение N часов", "прочитано, но нет ответа", "прошло N часов"
    - _Requirements: 5.1, 5.2_

  - [~] 11.2 Implement follow-up chain progress display on scheduled broadcasts page
    - Show chain progress: recipients per step, replied count, exited count
    - Display on `/dashboard/scheduled` page
    - _Requirements: 5.6_

- [ ] 12. A/B Test Creator (Frontend)
  - [~] 12.1 Implement `ABTestCreator` UI component
    - Create form for 2-4 message variants with text and optional file
    - Input for test percentage (10-50%) and wait hours
    - _Requirements: 6.1, 6.2_

  - [~] 12.2 Implement A/B test results display and winner selection
    - Show comparison table with delivery%, read%, reply% per variant
    - Allow user to select winner and trigger sending to remaining recipients
    - _Requirements: 6.3, 6.4_

- [ ] 13. Calendar Exceptions & Schedule Templates (Frontend)
  - [~] 13.1 Implement `CalendarExceptionsManager` UI component
    - Create UI for managing calendar exceptions on `/dashboard/scheduled`
    - Support single date, date range, and recurring exceptions (weekly/monthly/yearly)
    - Visually mark scheduled broadcasts affected by exceptions with "Будет отложена" warning
    - _Requirements: 8.1, 8.2, 8.5_

  - [~] 13.2 Implement Schedule Templates in ScheduleModal
    - Add "Сохранить как шаблон" button in schedule modal
    - Show list of saved templates with one-click apply
    - Allow rename and delete of templates
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

- [ ] 14. Adaptive Throttle Display (Frontend)
  - [~] 14.1 Implement real-time Adaptive Throttle status display
    - Show current Delivery_Score and throttle state (normal/slowed/paused) on active broadcast page
    - Display notification when broadcast is paused with recommendation to check instance
    - _Requirements: 7.5_

- [ ] 15. Integration and wiring
  - [~] 15.1 Wire Multi-Instance Selector into broadcast launch flow
    - Connect instance selection to broadcast API calls
    - Pass `instance_id` to scheduled broadcast creation
    - Validate instance health before launch
    - _Requirements: 4.2, 4.3, 4.4_

  - [~] 15.2 Wire Follow-Up Chain and A/B Test into scheduled broadcast creation
    - Add follow-up chain and A/B test options to scheduled broadcast modal
    - Pass `follow_up_chain_id` and `ab_test_id` to scheduled broadcast
    - Add `adaptive_throttle` toggle to broadcast settings
    - _Requirements: 5.5, 6.5, 7.6_

  - [~] 15.3 Wire Calendar Exception checking into scheduler tick
    - Integrate `calendar_exception_checker` into Flask scheduler main loop
    - Update `next_run_at` for affected broadcasts
    - Ensure fail-safe: exception in one task doesn't block others
    - _Requirements: 8.3_

- [~] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Frontend property tests use `fast-check` (TypeScript), backend property tests use `hypothesis` (Python)
- The encryption utility (`INSTANCE_ENCRYPTION_KEY`) must be configured in `.env` before running instance-related tasks
- Existing `Profile.green_api_*` fields remain for backward compatibility; new `GreenInstance` model handles multi-instance

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "3.1", "6.1", "7.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "3.3", "3.5", "3.6", "4.1", "6.2", "7.2"] },
    { "id": 3, "tasks": ["2.4", "3.4", "4.2", "4.3", "4.4", "6.3", "6.4"] },
    { "id": 4, "tasks": ["4.5", "4.6", "5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.4", "9.1", "9.2", "9.3", "9.4"] },
    { "id": 6, "tasks": ["9.5", "9.6", "9.7", "9.8", "10.1", "10.2"] },
    { "id": 7, "tasks": ["11.1", "11.2", "12.1", "12.2", "13.1", "13.2", "14.1"] },
    { "id": 8, "tasks": ["15.1", "15.2", "15.3"] }
  ]
}
```
