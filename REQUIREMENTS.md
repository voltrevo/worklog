# Worklog — Product Requirements

## Conventions

This document is **append-only**. Sections are append-only, and so is the list inside each section.

- **Every item has a stable identity.** `6.10` means the same thing forever, so anything may cite it
  without being kept up to date.
- **A superseded item is struck through, never deleted or renumbered.** ~~Like this.~~ The item that
  replaces it is appended to the same section with the next free number, and names what it
  supersedes.
- **New items continue the section's own sequence**, even when they supersede an earlier item in
  that section. Numbers are therefore not in logical order, only in the order they were written.
- **A genuinely new area gets a new section** rather than being appended to an existing one.

## Introduction

Worklog is a focused, self-hosted work time tracking and invoicing application intended to replace the small subset of Toggl needed for personal contracting work.

A shared frontend runs both as a Deno Desktop app and as a static web app on GitHub Pages. Multiple frontends may be connected concurrently, but the Deno server is always the source of truth and coordination authority. The server stores persistent state in SQLite, communicates over KPS, controls globally coordinated events such as work-detail prompts, maintains logs, and generates invoice PDFs.

Everyday use should stay extremely lightweight: start or stop work, see live progress for the current workday, edit history freely, and add approximate past work as duration-only entries without inventing fake start/end times. Entries carry billing tags used directly in invoices. The app also tracks monthly pace against configurable targets and can request text or voice notes about recent work.

Invoice generation preserves the essential structure of an existing invoice format while allowing visual polish. Generating a PDF is harmless preview/export; an invoice has accounting consequences only when explicitly marked issued, and can later be marked paid.

Device access is explicit and key-based after initial bootstrap. Device-local conveniences—including an optional looping background-audio file and Deno Desktop always-on-top behavior—remain entirely local and invisible to the server.

The product is intentionally narrow. Multi-project UI, transcription, accounting integrations, and broader productivity features are deferred.

## 1. Architecture & authority

1.1. MUST provide a shared frontend usable from both Deno Desktop and GitHub Pages.
1.2. MUST use a Deno backend.
1.3. MUST use SQLite for persistent backend storage.
1.4. MUST use KPS as the client/server transport.
1.5. MUST allow the GitHub Pages frontend to connect directly through KPS browser transport.
1.6. MUST allow the Deno Desktop frontend to connect to the same server.
1.7. MUST treat the server as the sole source of truth for persistent application state.
1.8. MUST treat the server as the coordination authority for shared runtime behavior.
1.9. MUST support many authorized frontends connected concurrently.
1.10. MUST safely serialize or coordinate concurrent writes.
1.11. MUST prevent frontend-local state from silently overriding authoritative server state.
1.12. MUST broadcast authoritative state changes to connected authorized frontends.
1.13. SHOULD use server-pushed events for timer, history, invoice, access, and prompt changes.
1.14. SHOULD share nearly all frontend application code between desktop and web variants.
1.15. SHOULD keep the application protocol over KPS small and application-specific.
1.16. SHOULD prefer one KPS stream per RPC-style request unless a better design is justified.
1.17. MUST implement the shared frontend as a React application built with Vite.
1.18. MUST build the GitHub Pages variant as a static bundle with no server-side rendering.
1.19. MUST share the application core — protocol client, state, and domain logic — across desktop, web, and both presentations of section 23.

## 2. Time tracking

2.1. MUST provide a start/stop timer for current work.
2.2. MUST allow at most one active timer globally.
2.3. MUST make timer start/stop authoritative server operations.
2.4. MUST immediately propagate timer changes to all connected authorized frontends.
2.5. MUST persist completed tracked work when the timer is stopped.
2.6. MUST provide fully editable work history.
2.7. MUST allow editing date, duration, billing tag, and timing details.
2.8. MUST support timed entries with explicit start and end times.
2.9. MUST support duration-only entries without fake start/end times.
2.10. MUST allow simple entries such as a duration attributed to yesterday.
2.11. MUST allow timed and duration-only entries on the same day.
2.12. ~~MUST allow conversion between timed and duration-only forms.~~ (superseded: 24.11)
2.13. MUST use recorded duration identically for reporting and billing regardless of representation.
2.14. SHOULD present work history primarily by day.
2.15. SHOULD make adding past time fast and obvious.
2.16. SHOULD warn about implausibly long active timers.
2.17. MUST NOT silently guess corrections for suspicious timers.
2.18. MUST attach every work entry to a plain calendar date.
2.19. MUST derive a timed entry's date from its start time in the local timezone of the device that started it.
2.20. MUST capture that date when the timer starts rather than when it stops.
2.21. MUST attribute a session crossing midnight entirely to its start date.
2.22. MUST allow the date of a duration-only entry to be chosen directly.
2.23. MUST NOT recompute a stored entry date from any other device's timezone.

## 3. Timer home screen

3.1. MUST make live total work duration for the current day the primary home-screen metric.
3.2. MUST compare today's live total against configured expected hours per workday.
3.3. SHOULD show worked, target, and remaining/over-target duration at a glance.
3.4. MUST update today's total live while a timer is active.
3.5. MUST show current active-session duration when working.
3.6. MUST make active-session duration visually secondary to today's total.
3.7. MUST keep start/stop controls obvious despite the changed metric priority.
3.8. SHOULD show the current monthly ahead/behind pace on the home screen.
3.9. MUST treat "today" as the current calendar date in the viewing device's local timezone.
3.10. MAY therefore show a different today-total on devices in different timezones; this is accepted in v1 rather than reconciled against a server timezone.

## 4. Billing tags

4.1. MUST allow each work entry to have a billing tag.
4.2. MUST use the billing tag as the invoice “Description of work / expense” value.
4.3. MUST support different billing tags on different entries.
4.4. MUST support multiple billing tags on the same date.
4.5. SHOULD remember recently used billing tags.
4.6. SHOULD provide lightweight autocomplete from previously used tags.
4.7. SHOULD avoid a separate tag-management workflow for ordinary use.
4.8. MUST NOT expose project selection in the initial time-tracking UI.
4.9. MAY keep an invisible/default internal project concept only for future compatibility.

## 5. Work-detail notes & prompts

5.1. MUST support work-detail notes separately from billable time entries.
5.2. MUST allow a work-detail note to contain text.
5.3. MUST allow a work-detail note to contain a voice recording.
5.4. MUST allow work-detail notes to be created manually at any time appropriate to the UI.
5.5. ~~MUST provide a manual “new work note” action from the main workflow.~~ (superseded: 24.4)
5.6. MUST support random work-detail prompts only while the authoritative timer is active.
5.7. MUST allow configuration of the average prompt interval.
5.8. MUST have the server evaluate prompt timing.
5.9. MUST have the server poll approximately every 10 seconds while the timer is active.
5.10. MUST calculate each prompt probability from actual elapsed time since the previous server poll.
5.11. MUST clamp elapsed time so it never reaches before the current timer start.
5.12. MUST use the approximation `p = elapsed / meanInterval`.
5.13. MUST discard prompt-process timing state when the timer stops.
5.14. MUST NOT schedule and preserve a future exponential prompt timestamp.
5.15. MUST create only one authoritative prompt event for each trigger.
5.16. MUST notify all currently listening eligible frontends when a prompt event fires.
5.17. MUST let each notified frontend present the prompt and play its local notification tune.
5.18. MUST drop a prompt event if it cannot be delivered to any listening frontend.
5.19. MUST log a warning when a prompt event is dropped for lack of a listener.
5.20. MUST NOT replay a stale dropped prompt later.
5.21. MUST allow prompted notes to be dismissed without answering.
5.22. MUST allow text responses to prompts.
5.23. MUST allow voice responses to prompts.
5.24. MUST retain submitted voice recordings.
5.25. MUST encode retained voice notes using Opus.
5.26. SHOULD use low-bitrate mono audio sufficient for intelligible speech.
5.27. SHOULD target roughly 16–24 kbit/s unless testing suggests otherwise.
5.28. MUST allow stored voice notes to be played back.
5.29. SHOULD preserve original audio if derived text is added later.
5.30. MUST NOT require transcription in v1.
5.31. MUST clamp the probability of 5.12 to at most 1, so that a delayed poll cannot exceed certainty.

## 6. Monthly pacing

6.1. MUST allow configuration of target work hours per month.
6.2. ~~MUST allow configuration of expected hours per workday.~~ Superseded by 6.21 and 6.25.
6.3. ~~MUST treat Saturdays and Sundays as non-working days by default.~~ Superseded by 6.23.
6.4. ~~MUST treat relevant NSW public holidays as non-working days.~~ Superseded by 6.31.
6.5. ~~MUST use an updateable NSW public-holiday source rather than only recurring hard-coded rules.~~ Superseded by 6.31.
6.6. SHOULD cache holiday data server-side.
6.7. ~~MUST distinguish ordinary NSW public holidays from bank holidays that are not general public holidays.~~ Superseded by 6.33.
6.8. SHOULD ignore local/regional holidays unless explicitly enabled later.
6.9. MUST calculate actual work before today from recorded entries.
6.10. ~~MUST assume today's full expected workday contribution when today is a workday.~~ Superseded by 6.26.
6.11. ~~MUST ignore today's actual partial progress in the monthly projection formula.~~ Superseded by 6.26.
6.12. ~~MUST assume each remaining workday contributes the configured expected daily hours.~~ Superseded by 6.25.
6.13. ~~MUST calculate projected hours as actual-before-today plus expected-today plus expected-remaining.~~ Superseded by 6.29.
6.14. MUST calculate pace as projected hours minus monthly target.
6.15. MUST display positive pace as ahead and negative pace as behind.
6.16. ~~MUST calculate monthly nominal capacity as workdays multiplied by expected daily hours.~~ Superseded by 6.30.
6.17. MUST calculate monthly slack as nominal capacity minus monthly target.
6.18. SHOULD expose capacity/slack context in pacing details.
6.19. ~~SHOULD allow future per-day pacing overrides such as leave or intentional weekend work.~~ (superseded: 24.20)
6.20. ~~MUST keep pacing-day overrides separate from billable work records.~~ (superseded: 24.20)
6.21. MUST allow configuration of a weekly work schedule as one time interval per weekday.
6.22. MUST allow a weekday's interval to be empty, meaning that weekday is not a workday.
6.23. MUST default the schedule to empty on Saturday and Sunday. Supersedes 6.3.
6.24. MUST treat a day with a non-empty interval as a workday, except where a public holiday or a pacing-day override says otherwise.
6.25. MUST derive a workday's expected hours from the length of its scheduled interval. Supersedes 6.2 and 6.12.
6.26. MUST calculate today's projected contribution as work already recorded today plus the part of today's scheduled interval that has not yet elapsed. Supersedes 6.10 and 6.11.
6.27. MUST update today's projected contribution live, both as work is recorded and as the scheduled interval elapses.
6.28. MUST count work recorded outside today's scheduled interval in full, so that early or extra work reads as ahead rather than being absorbed.
6.29. MUST calculate projected hours as actual-before-today, plus today's projected contribution, plus the scheduled hours of each remaining workday. Supersedes 6.13.
6.30. MUST calculate monthly nominal capacity as the sum of scheduled hours across the month's workdays. Supersedes 6.16.
6.31. MUST obtain public holidays from a source keyed by a configurable region code rather than one specific to NSW. Supersedes 6.4 and 6.5.
6.32. MUST default the configured region to New South Wales, Australia.
6.33. MUST distinguish ordinary public holidays from bank holidays that are not general public holidays, using the source's own classification. Supersedes 6.7.
6.34. MUST ship a checked-in holiday snapshot, used when the source is unreachable.
6.35. MUST NOT let a failed holiday fetch silently change a month's workday count.
6.36. MUST log a warning when holiday data falls back to cache or to the shipped snapshot.
6.37. ~~SHOULD show which holidays a month's pacing used, so a wrong or missing one is visible rather than only shifting the pace.~~ (superseded: 24.19)
6.38. MUST interpret the schedule's times as local to the viewing device.
6.39. MUST NOT ask the holiday source anything when no region is configured, and MUST say that no region is set rather than reporting the source as unreachable. 24.33 forbids defaulting the region, so this is the state every new server starts in.

## 7. Reports

7.1. MUST provide monthly work reports.
7.2. MUST show total worked hours for the selected month.
7.3. MUST derive totals from work-entry durations.
7.4. MUST support arbitrary half-open date ranges internally.
7.5. SHOULD provide daily work totals.
7.6. SHOULD provide totals grouped by billing tag.
7.7. MUST show work in reports regardless of invoice issuance state.
7.8. SHOULD distinguish uninvoiced, invoiced/unpaid, and paid work where useful.
7.9. MUST offer calendar-month selection only in v1, while keeping 7.4's internal ranges.
7.10. MUST derive an entry's month from its stored calendar date, with no timezone conversion.
7.11. MUST derive an entry's invoice state from the invoice covering its month and from that invoice's frozen snapshot, rather than from a flag on the entry.

## 8. Invoice generation & layout

8.1. MUST generate invoice PDFs from application data.
8.2. MUST generate canonical invoice PDFs on the server.
8.3. MUST preserve the essential structure and layout of the supplied invoice format.
8.4. MAY improve typography, spacing, alignment, and visual polish.
8.5. MUST NOT substantially reorganize invoice content without explicit approval.
8.6. MUST include invoice identity/metadata near the top.
8.7. MUST include bill-to details near the top.
8.8. MUST include the invoiced time period.
8.9. MUST include a work/expense table.
8.10. MUST include columns equivalent to Date, Description of work / expense, Team/Project, Hours, Rate, and Amount.
8.11. MUST include subtotal, tax/VAT where applicable, and total.
8.12. MUST include work-approver information when configured.
8.13. MUST include payment details when configured.
8.14. MUST include a payment due date.
8.15. MUST allow PDF generation without changing invoice accounting state.
8.16. MUST allow repeated draft generation/regeneration safely.
8.17. MUST include every work entry whose date falls within the invoice's period, without filtering.
8.18. MUST restrict an invoice's period to one whole calendar month in v1.
8.19. MUST render the monthly bonus in its own table, above the work table, with its own subtotal row. Supersedes the reading of 9.11 as a first row of the work table.
8.20. MUST label the bonus row's Date cell with the period it covers rather than with a single date.
8.21. MUST give the bonus row its own Team/Project value, separate from the work rows'.
8.22. MUST end the work table with a Total row carrying the summed hours and the summed amount.
8.23. MUST show the sender's name, postal address, telephone number and email address in the header.
8.24. MUST show the invoice number and the invoice date at the top right, as labelled fields.
8.25. MUST show the bill-to block as a distinct, visually set-apart block.
8.26. MUST show the invoiced time period as a labelled field of its own.
8.27. MUST head the table section "Description of work performed".
8.28. MUST show the currency the hourly rate is in, and the work approver, below the tables.
8.29. MUST show sub-total, VAT (if applicable) and TOTAL right-aligned below the tables, with TOTAL emphasised.
8.30. MUST include a "Method of payment" block giving the payment method and the account fields as labelled rows.
8.31. MUST show the payment due date as a labelled field at the foot.
8.32. MAY include a note beneath the totals, such as one about currency conversion, when configured.
8.33. MUST deliver a generated PDF to the frontend that requested it, not only to the server's data directory — the requester is frequently a device with no access to that directory.
8.34. MUST let the desktop shell write a delivered file itself, because a `file://` page has no dependable download destination.

## 9. Invoice configuration

9.1. MUST obtain invoice identity details from user configuration.
9.2. MUST obtain client/bill-to details from user configuration.
9.3. MUST obtain rate, currency, tax, approver, and payment details from user configuration.
9.4. MUST NOT hard-code personal or financial information from supplied invoices.
9.5. MUST NOT place real personal information into project plans, source, fixtures, screenshots, tests, examples, or defaults.
9.6. MUST use clearly fictional development/demo/test data.
9.7. MUST allow “Team/Project” to be configured per invoice.
9.8. MUST default “Team/Project” to the previous invoice's value.
9.9. MUST allow a monthly bonus amount per invoice.
9.10. MUST default monthly bonus to the previous invoice's value.
9.11. MUST render monthly bonus as its own invoice line before ordinary time entries.
9.12. SHOULD default other recurring invoice fields from the previous invoice where safe and useful.
9.13. MUST resolve “the previous invoice” of 9.8, 9.10 and 9.12 as the invoice with the most recent period.
9.14. MUST default the invoice number to `INV-YYYY-MM`, derived from the period.
9.15. MUST allow the invoice number to be edited while the invoice is a draft.
9.16. MUST require invoice numbers to be unique among issued invoices.
9.17. MUST obtain the sender's telephone number from configuration, for 8.23.
9.18. MUST hold payment details as labelled fields -- account name, BSB, account number, bank -- rather than as free text, so that 8.30 can render them as rows.
9.19. MUST treat every payment field of 9.18 as sensitive under 20.1, and withhold all of them from read responses.
9.20. MUST allow the payment method wording, such as "Wire Transfer", to be configured.
9.21. MUST allow the bonus line's Team/Project to be configured, defaulting to "General".
9.22. MUST allow an optional note to be configured for 8.32.
9.23. MUST record an invoice date, distinct from both the period and the due date, defaulting to the day the invoice is prepared and frozen at issuance.

## 10. Invoice due date

10.1. MUST default payment due date from the current date when preparing the invoice.
10.2. MUST first add exactly four weeks.
10.3. MUST leave that date unchanged when it is a Monday.
10.4. MUST otherwise move it forward to the following Monday.
10.5. MUST show the calculated due date before issuance.
10.6. MAY allow explicit manual override if later required.
10.7. MUST recalculate the due date while the invoice remains a draft.
10.8. MUST freeze the due date at issuance, as part of the snapshot of 11.6.

## 11. Invoice lifecycle

11.1. MUST model invoice status explicitly.
11.2. MUST support at least `draft`, `issued`, and `paid` states.
11.3. MUST treat generated invoices as drafts until explicitly issued.
11.4. MUST NOT mark work as invoiced merely because a PDF was generated.
11.5. MUST provide an explicit “Mark as issued” action.
11.6. MUST freeze the invoice snapshot at issuance.
11.7. MUST associate included work with the issued invoice.
11.8. MUST prevent later work-entry edits from silently changing an issued invoice.
11.9. MUST allow an issued invoice to be marked paid.
11.10. MUST record issuance time.
11.11. MUST record payment time.
11.12. SHOULD allow deliberate corrective actions to unmark paid.
11.13. SHOULD allow deliberate corrective actions to revert issuance when appropriate.
11.14. MUST make corrective state changes explicit rather than incidental.
11.15. SHOULD show invoice status clearly in invoice lists.
11.16. SHOULD show due dates for issued/unpaid invoices.
11.17. SHOULD make drafts visually distinct.
11.18. SHOULD retain issued invoice snapshots/PDFs for later reference.
11.19. MUST refuse to issue an invoice whose period overlaps that of an already issued or paid invoice.
11.20. MUST therefore permit at most one issued-or-paid invoice per calendar month, given 8.18.
11.21. MUST free a period for reissue when an invoice's issuance is reverted under 11.13.
11.22. MUST allow drafts to overlap each other and to overlap issued periods.
11.23. MUST record the identity of every included work entry in the frozen snapshot of 11.6.
11.24. MUST warn when a month containing work has no issued or paid invoice while a later month does.
11.25. MUST warn when a work entry's date falls inside an invoiced month but the entry is absent from that invoice's snapshot.
11.26. MUST NOT block issuance on the warnings of 11.24 or 11.25.
11.27. MUST warn when the work an issued invoice was built from no longer adds up to the hours that invoice states, whether because an entry was shortened or because it was deleted. 11.25 is a set difference over the snapshot's ids and cannot see either.
11.28. MUST NOT block anything on the warning of 11.27, per 11.26; and MUST NOT report an addition under 11.27 as well as under 11.25, since one event should not arrive as two warnings.

## 12. Server logging & diagnostics

12.1. MUST maintain sensible structured server logs.
12.2. MUST timestamp log entries.
12.3. MUST include severity and subsystem/source where useful.
12.4. MUST log meaningful state transitions and failures without excessive noise.
12.5. MUST log dropped work-detail prompts.
12.6. MUST allow frontends to submit frontend errors to the server for centralized logging.
12.7. MUST associate submitted frontend errors with the authenticated device where possible.
12.8. SHOULD include useful stack/context data after removing sensitive values.
12.9. MUST provide an in-app server-log viewer.
12.10. MUST make server logs viewable from authorized frontends.
12.11. SHOULD restrict sensitive diagnostic detail to admins.
12.12. SHOULD provide level and time-range filters.
12.13. SHOULD use bounded log retention or rotation.
12.14. SHOULD queue transiently unsent frontend error reports locally when the server is temporarily unreachable.
12.15. MUST NOT let diagnostic reporting expose secrets, private keys, bank details, or other sensitive configuration.
12.16. MUST accept frontend error reports only from authorized devices, so an unauthorized device cannot fill the log.
12.17. MUST redact sensitive configuration values from log entries served to non-admin devices, as the concrete form of 12.11.

## 13. Access control & device identity

13.1. MUST require explicit device authorization after initial bootstrap.
13.2. MUST generate a device secret/private key locally if one does not already exist.
13.3. MUST persist the device private key locally.
13.4. MUST never send the device private key to the server.
13.5. MUST derive a stable device identity from the corresponding public key.
13.6. MUST allow the first frontend to bootstrap access only while the server has no authorized devices.
13.7. MUST label the initial bootstrap action “Claim admin”.
13.8. MUST require explicit user confirmation before claiming initial admin.
13.9. MUST grant the successfully claimed first device admin access.
13.10. MUST permanently disable automatic first-device claiming once bootstrap has completed, unless server state is deliberately reset.
13.11. MUST show “Request access” rather than “Claim admin” to later unauthorized devices.
13.12. MUST require an access requester to specify a device name.
13.13. MUST require an access requester to request `read`, `write`, or `admin` access.
13.14. MUST NOT automatically authorize subsequent devices.
13.15. MUST make the server issue a fresh random challenge for device proofs.
13.16. MUST make challenge values short-lived and single-use.
13.17. MUST require access requests to be signed by the requesting device key.
13.18. MUST bind the signature to the device description/name.
13.19. MUST bind the signature to the requested access level.
13.20. MUST bind the signature to the device public key.
13.21. MUST bind the signature to a timestamp.
13.22. MUST bind the signature to the server-provided random challenge.
13.23. MUST bind the signature to the intended server identity/KPS certificate hash.
13.24. MUST reject invalid, expired, replayed, or mismatched signed requests.
13.25. MUST show pending access requests to admins.
13.26. MUST show device name, requested role, public-key fingerprint, and request age/time in the admin queue.
13.27. MUST let admins explicitly approve or deny each request.
13.28. MUST grant only the role approved by an admin.
13.29. MUST persist authorized device public keys and granted roles.
13.30. MUST require authorized devices to prove possession of their private key on later connections.
13.31. MUST use a fresh server challenge for subsequent authentication.
13.32. MUST define `read` as non-mutating application access.
13.33. MUST define `write` as ordinary application mutation without access-control administration.
13.34. MUST define `admin` as including write access plus access-control administration.
13.35. SHOULD allow admins to review currently authorized devices.
13.36. SHOULD allow admins to revoke a device.
13.37. SHOULD allow admins to change a device's granted role.
13.38. MUST treat device names as untrusted display strings rather than identities.
13.39. MUST reject an admin claim once any device has been authorized, deciding the race on the server rather than in the frontend.
13.40. MUST let a frontend whose claim was rejected fall back to “Request access” without losing what the user had already entered.
13.41. MUST treat the KPS address of section 22 as the out-of-band capability that gates 13.6; no separate bootstrap code is required.
13.42. MUST say when a device's access is read-only, once and somewhere every screen carries, rather than leaving disabled controls to explain themselves. A disabled control looks the same as a broken one.

## 14. Local looping audio

14.1. MUST provide an opt-in looping background-audio feature while the timer is active.
14.2. MUST make the audio-loop feature entirely frontend/device-local.
14.3. MUST NOT upload the loop audio file to the server.
14.4. MUST NOT store loop-audio configuration on the server.
14.5. MUST NOT give the server awareness of whether looping audio is configured or enabled.
14.6. MUST allow the user to drop/import one audio file from a local configuration screen.
14.7. SHOULD copy/store the selected file in device-local application storage so the original path is not required.
14.8. MUST expose only an Enabled/Disabled control and Volume control during ordinary use.
14.9. MUST NOT expose play/pause controls.
14.10. MUST NOT expose seeking.
14.11. MUST NOT implement playlists or music-library behavior.
14.12. MUST loop the selected file continuously while Enabled and the authoritative timer is active.
14.13. MUST stop local loop playback when the authoritative timer stops.
14.14. MUST start local loop playback when an active timer becomes authoritative and local looping is Enabled.
14.15. SHOULD restart playback from the beginning when a new work session starts.
14.16. MUST allow each connected device to enable/disable looping independently.
14.17. MUST allow multiple devices to play independently without server coordination.
14.18. MUST make loop volume independent of system master volume.
14.19. MUST use a perceptually appropriate logarithmic/decibel gain mapping.
14.20. MUST provide fine control at very low listening levels.
14.21. MUST avoid an artificial practical volume floor such as 5–10% linear amplitude.
14.22. MUST map zero volume to true silence.
14.23. SHOULD provide a broad attenuation range, roughly 60 dB or more before mute.
14.24. MUST NOT apply automatic normalization or compression merely to make low-volume control easier.
14.25. ~~MUST hide the looping-audio feature in the mobile presentation, where autoplay restrictions and background suspension make 14.12 unhonourable.~~ (superseded: 25.20)

## 15. Deno Desktop local window behavior

15.1. MUST provide an Always on top toggle in the Deno Desktop version.
15.2. MUST make Always on top entirely device-local.
15.3. MUST persist Always on top locally on that device.
15.4. MUST apply changes immediately to the desktop window where supported.
15.5. MUST NOT expose Always on top in the GitHub Pages version.
15.6. MUST NOT store Always on top state on the server.
15.7. MUST NOT give the server awareness of Always on top state.
15.8. MUST show the window's actual state rather than the request when Always on top is not honoured. 15.4's "where supported" is unmeetable unless the app finds out whether it is: a ticked box above a window sitting behind everything is a claim, not a setting.

## 16. Local-only boundary

16.1. MUST keep loop-audio file contents, filename/path, enabled state, and volume local to the device.
16.2. MUST keep Always on top state local to the device.
16.3. MUST NOT include local-only audio or window-state values in server RPCs, telemetry, or logs.
16.4. MUST sanitize forwarded frontend errors so they do not reveal local-only audio/window configuration.
16.5. MAY keep device-local diagnostic information locally when forwarding it would violate the local-only boundary.
16.6. MUST continue using authoritative server timer state as the trigger for local device behavior.
16.7. MUST keep the configured server address of section 22 local to the device.

## 17. Data model & persistence

17.1. MUST preserve whether a work entry is timed or duration-only.
17.2. MUST preserve billing tags on work entries.
17.3. MUST preserve submitted work-detail text notes.
17.4. MUST preserve submitted work-detail voice notes.
17.5. MUST preserve invoice snapshots separately from mutable source work data.
17.6. MUST preserve invoice lifecycle timestamps.
17.7. MUST preserve authorized-device public keys and permissions.
17.8. MUST support schema migrations from the beginning.
17.9. SHOULD use SQLite STRICT tables/features where practical.
17.10. SHOULD store large audio-note files outside SQLite and reference them from SQLite.
17.11. SHOULD store generated invoice PDFs outside SQLite and reference them from SQLite.
17.12. MUST ensure server-persistent state survives frontend restarts and reconnects.
17.13. MUST store a work entry's date as a plain calendar date rather than as an instant, so that 7.10 needs no timezone.

## 18. GitHub & About

18.1. MUST use the product name “Worklog”.
18.2. MUST provide an About screen.
18.3. MUST show application version/build information on the About screen.
18.4. MUST provide a direct “View on GitHub” link to `github.com/voltrevo/worklog`.
18.5. MUST provide a direct “Report an issue” link to that repository's new-issue flow.
18.6. SHOULD keep repository URLs as build/application metadata rather than user invoice configuration.

## 19. UI / UX

19.1. MUST keep the primary workflow lightweight.
19.2. MUST avoid project-selection UI in v1.
19.3. MUST make today's live progress the visual priority on the main screen.
19.4. MUST make current-session duration available but secondary.
19.5. MUST make billing tags visible when reviewing/editing entries.
19.6. MUST distinguish duration-only entries visually from timed intervals.
19.7. MUST make manual past-time entry require minimal interaction.
19.8. MUST make manual work-note creation easy to reach.
19.9. ~~MUST make invoice preview/generation clearly separate from issuance.~~ (superseded: 24.26)
19.10. MUST make “Mark as issued” an explicit action.
19.11. MUST make “Mark as paid” an explicit action.
19.12. MUST provide a device-access administration screen for admins.
19.13. MUST provide a server-log viewing screen.
19.14. SHOULD keep visual design clean, modern, restrained, and desktop-friendly.
19.15. SHOULD avoid dense enterprise/project-management UI.
19.16. MUST style the UI with plain CSS, using custom properties as design tokens, rather than a utility-class or CSS-in-JS framework.
19.17. MUST support both light and dark presentation.
19.18. MUST follow the supplied mockups for the desktop presentation's sidebar layout, treating them as indicative of structure rather than of exact pixels.

## 20. Privacy & safety

20.1. MUST treat invoice identity, addresses, contact details, bank details, rates, and client details as sensitive.
20.2. MUST NOT expose sensitive configuration in logs unnecessarily.
20.3. MUST NOT embed user-sensitive values in public frontend bundles.
20.4. MUST keep secrets server-side where feasible.
20.5. MUST keep device private keys device-local.
20.6. MUST avoid shipping real user data in GitHub Pages assets.
20.7. MUST ensure screenshots, examples, and fixtures use fictional data.
20.8. MUST NOT infer missing personal or financial information from supplied invoices.
20.9. MUST require the user to configure missing invoice/payment information.
20.10. MUST never log authentication private keys or reusable secrets.

## 21. Deferred / out of scope

21.1. Multi-project selection UI is deferred.
21.2. Renaming/enabling multiple projects is deferred.
21.3. Automatic speech transcription is deferred.
21.4. AI summarization of work notes is deferred.
21.5. Team collaboration and multi-user work ownership are deferred.
21.6. Payroll and tax filing are deferred.
21.7. Accounting-system integration is deferred.
21.8. Leave management is deferred beyond possible pacing-day overrides.
21.9. General expense management is deferred.
21.10. Mobile-native applications are deferred.
21.11. Music-app features beyond one local looping file are explicitly out of scope.
21.12. Cloud-hosted application infrastructure is not required.
21.13. Toggl feature parity is explicitly not a goal.
21.14. Filtering which work appears on an invoice is deferred; v1 includes all work in the period, per 8.17.
21.15. Custom invoice and report date ranges are deferred; v1 offers calendar months only, per 7.9 and 8.18.
21.16. Work schedules richer than one interval per weekday are deferred; the schedule of 6.21 is an approximation and is meant to stay one.
21.17. Reconciling “today” across devices in different timezones is deferred, per 3.10.
21.18. Mobile *native* applications remain deferred per 21.10; the mobile *web* presentation of section 23 is in scope.
21.19. Encoding connection state in the URL is out of scope, per 22.4.

## 22. Server address & connection

22.1. MUST require the user to supply the server's KPS address before the frontend can connect.
22.2. MUST accept that address in KPS `<ip>:<port>:<certhash>` form.
22.3. MUST persist the address in device-local storage, alongside the device key of 13.3.
22.4. MUST NOT encode the address, or any other connection state, in the URL; the app is entered app-first, with no URL semantics.
22.5. MUST NOT ship any server address in the GitHub Pages bundle.
22.6. MUST allow the stored address to be changed or cleared.
22.7. MUST show connection state, distinguishing at least “no address configured”, “connecting”, “connected”, and “failed”.
22.8. SHOULD reconnect automatically after a transient loss.
22.9. MUST treat a malformed address as a configuration error shown in the UI rather than as a connection failure.
22.10. MUST find out that a connection has been lost rather than waiting to be told. A transport whose peer has stopped reports nothing, so the app must ask on an interval and treat silence as a loss; saying "Connected" about a server that has stopped is worse than saying nothing.
22.11. MUST keep a server's address stable across a restart, so that a restart does not silently invalidate every device's stored address.

## 23. Mobile presentation

23.1. MUST provide a mobile presentation in addition to the desktop presentation.
23.2. MUST design the mobile presentation independently rather than as a narrowed desktop layout; the supplied mockups describe the desktop/tablet layout only.
23.3. MUST share the application core of 1.19 between the two presentations, varying only the shell, navigation and layout.
23.4. MUST select the presentation from the viewport rather than from the runtime, so the desktop app and the web app each reach both.
23.5. MUST validate both presentations with Playwright screenshots.
23.6. SHOULD keep every v1 capability reachable in the mobile presentation, except where a section explicitly excludes it, as 14.25 does.
23.7. MUST validate the write path end to end from two concurrent devices, because a screenshot proves a screen renders and not that pressing anything on it works.

## 24. Review feedback, first pass

Everything in this section comes from a review of `ef34c75` driving the running app. Items here
supersede the struck items they name.

### Principles

24.1. MUST NOT substitute a default for a missing required value; the action MUST be rejected instead, naming the field that is missing.
24.2. MUST reduce the timer screen to two boxes: today's total against the day's scheduled hours with its progress bar, and the current session with its start/stop control and billing tag.
24.3. MUST make destructive and state-changing actions reversible from the UI wherever the record is not inherently append-only; server logs are append-only, invoices are not.

### Work notes

24.4. MUST give work notes their own tab rather than a card on the timer screen.
24.5. MUST show live capture feedback — a waveform or level meter — while a voice note is recording, so silence or a dead microphone is visible before five minutes have been spoken into it.
24.6. MUST allow a work note to be deleted.
24.7. MUST render a voice-only note as something better than the words "a recording"; the note list must read as a list of notes whether they are spoken or written.

### The timer screen

24.8. MUST remove "Today's entries" from the timer screen outright; History already shows them, and shows them editable.
24.9. MUST reject starting a timer with no billing tag rather than defaulting it to "Work".
24.10. MUST allow the billing tag of a *running* timer to be corrected without stopping it.

### History

24.11. MUST allow a past entry to be added either as a duration on a date or with explicit start and end times; 2.9's duration-only form stays, and is no longer the only form.
24.12. MUST allow the start and end times of an existing timed entry to be edited, rather than only dropped.
24.13. MUST confirm before deleting a work entry.
24.14. MUST keep the month navigation controls in fixed positions, so a control does not move out from under the pointer when a neighbouring one appears.
24.15. MUST show the month summary for an empty month as zeros rather than hiding it, so an empty month reads as the same screen with nothing in it.
24.16. MUST NOT show invoice state on the History screen; invoicing belongs to the invoices screen.

### Pacing

24.17. MUST reduce the pacing headline to two figures: how far ahead or behind, prominently, and the projected month total beside it. No title, no explanatory paragraph, no target comparison in that box.
24.18. MUST move the explanation of how the projection is computed out of the screen and into help or documentation.
24.19. MUST remove the "How the projection adds up" breakdown and the "Public holidays used" box.
24.20. MUST remove the pacing-day override editor; the idea is worth revisiting, but it was not asked for and it crowds the screen.
24.21. MUST NOT show the configured monthly target on the pacing screen; it is configuration and it does not change.
24.22. ~~MUST keep "Worked so far", and MUST compare it against where the month should be by now — the pro-rated target for the scheduled time already elapsed.~~ (superseded: 24.40)
24.23. ~~MUST make that "actual against expected so far" comparison the more prominent of the two readings, ahead of the end-of-month projection.~~ (superseded: 24.41)
24.24. MUST keep the per-day calendar at the foot of the pacing screen.

### Invoices

24.25. MUST present invoices as a single list with no notion of a "current" invoice: drafts and issued-but-unpaid first, paid ones below.
24.26. MUST remove the inline invoice preview; the list carries the number, the period, the status, the hours and the amount, and the PDF carries the rest.
24.27. MUST offer every lifecycle action — issue, mark paid, revert, delete — per row from that list.
24.28. MUST allow an invoice to be deleted.
24.29. MUST present the issuance warning as a dialog rather than inline.
24.30. MUST freeze the rendered PDF when an invoice is issued, and serve that stored file thereafter rather than re-rendering from data.
24.31. MUST refuse to generate an invoice while required invoice configuration is missing, naming what is missing, rather than rendering a document with blanks in it.

### Settings

24.32. MUST validate the holiday region before accepting it, and SHOULD offer a picker rather than a free-text field.
24.33. MUST NOT default the holiday region; Mon–Fri 09:00–17:00 and a 160-hour monthly target are good defaults and stay.
24.34. MUST treat the ABN as optional; the supplied invoice format does not carry one.
24.35. MUST NOT default the tax label to "GST", or to anything else.
24.36. MUST NOT invent any invoice identity, address, contact or tax detail as a default.
24.37. MUST NOT default the payment method wording.

### Serving the frontend

24.38. MUST detect that `crypto.subtle` is unavailable — a page served over plain HTTP from anything but localhost is not a secure context — and say so, rather than failing inside the first signature.
24.39. SHOULD document that the static frontend needs HTTPS or localhost, and SHOULD serve the development build accordingly.

### Pacing, corrected

24.22 and 24.23 asked for "actual against where you should be by now" as a number, and the number
does not exist. A month with 176 scheduled hours and a 160-hour target has 16 hours of slack, so
staying on track means "should be" opens the month at −16 hours and only becomes positive part-way
through. That is a worse thing to read than the projection it was meant to replace.

24.40. MUST keep the ahead/behind figure as it is: projected month total against the monthly target.
24.41. MUST show the same comparison as two bars instead of as a second number — one for progress through the month's available scheduled hours, one for hours worked against the target — so being ahead or behind is the offset between them and no negative quantity has to be explained.
24.42. MUST validate the holiday region by asking the holiday source whether it yields any holidays, and MUST reject a region that yields none; 24.32's picker is declined — the field stays free text, because the country list needs the network and the subdivision codes are only discoverable by fetching a year of a country's holidays anyway.

## 25. Review feedback, second pass

From driving `c739357`. Where an item here contradicts an earlier one, the earlier one is struck and
names this.

### Principles

25.1. MUST distinguish "not loaded yet" from "empty" everywhere; a list that says "nothing yet" while it is still fetching is telling the user something untrue.
25.2. MUST render an unavailable or unsupported control as disabled, with a reason, rather than omitting it.
25.3. MUST NOT accept an invalid value into a field and silently keep or ignore it; either reject it visibly or make the field not editable.
25.4. MUST confirm destructive or hard-to-reverse actions in a dialog rather than inline in the row.
25.5. MUST look at the rendered screen before treating a change as finished; a screenshot run that does not throw is not evidence that the screen is right.

### Durations

25.6. MUST render durations as hours to one decimal place, using banker's rounding, everywhere except the live running-session clock, which stays `hh:mm:ss`.
25.7. MUST freeze the banker's-rounded hours as the official value on an invoice, and compute its totals from those, so the document adds up to the numbers printed on it. A rounding error of up to three minutes per line is accepted.

### Invoices

25.8. MUST keep the invoice list permanently on screen, with an explicit control for adding to it rather than a per-month button that appears and disappears.
25.9. MUST offer a month to invoice when adding, prefilled sensibly, and MUST NOT refuse or hide the option because a draft already exists for that month.
25.10. MUST allow any number of overlapping drafts; 11.19's refusal applies at issuance and nowhere earlier.
25.11. MUST detach a draft from the work entries when it is created: its lines are copied once and are then editable, addable and removable on the draft alone, leaving History untouched.
25.12. MUST allow a draft to carry its own configuration, overriding the global invoice settings for that draft only.
25.13. ~~MUST label the download control "Download" rather than "PDF"; the invoice is a PDF.~~ (superseded: 26.11)
25.14. MUST give the invoice list a consistent row height and put separating rules only between rows, never above the first.
25.15. MUST show the invoice configuration as an approximation of the rendered invoice, with each field positioned where its value appears on the document. Per-invoice content may be abbreviated.

### The invoice document

25.16. MUST increase the vertical gap between "BILL TO" and the block beneath it.
25.17. MUST reduce the horizontal gap between a label and its value for "Time period", "Hourly rate in" and "Work Approver".
25.18. MUST print the configured payment method verbatim, not as "{currency} ({value})".

### Audio

25.19. MUST detect that playback was blocked — `play()` rejecting under an autoplay policy — and offer an explicit control to start it, rather than discarding the rejection.
25.20. MUST make the looping-audio feature available in the mobile presentation, superseding 14.25.
25.21. MUST apply a volume change to audio that is already playing.
25.22. MUST apply removing the file, or disabling the feature, to audio that is already playing.
25.23. MUST provide a preview play/pause in settings, so the loop can be heard without starting a timer.

### Pacing and the timer

25.24. MUST default to Monday–Friday being workdays when no holiday region is configured, rather than treating a weekday as unscheduled.
25.25. MUST align the pacing bars with each other, so their fills can be compared; differing label widths must not change where a bar starts or ends.
25.26. MUST draw today's progress bar as one segment per entry, each with its own rounded ends, so the total reads as something assembled from parts.
25.27. MUST allow the start time of a running timer to be edited.

### Entries

25.28. MUST NOT allow the duration of a timed entry to be edited directly; it is the interval. A control converts the entry to duration-only, after which the duration is editable.
25.29. MUST recompute and show a timed entry's duration as its start and end are edited, before saving.
25.30. MUST use one editor for adding a past entry and for editing an existing one, reached from a control within the list rather than a separate panel above it.

### Access

25.31. MUST offer the requested role as a dropdown with a single request button, not one button per role.
25.32. MUST reduce the pending-request actions to approve and deny; approving grants the role that was asked for, and a wrong request is denied and resubmitted.
25.33. MUST show a device whose request was approved that it has been, with a primary control to continue into the app.
25.34. MUST indicate which of the admin screen's tabs is active.
25.35. MUST confirm revoking access, and changing a device's role, in a dialog.

### Notes

25.36. MUST update the recording waveform continuously; a trace that is mostly flat with occasional static is not showing the input.
25.37. MUST present one control for playing a voice note, which shows that it is loading and then plays, rather than a button that becomes a player which must be pressed again.
25.38. ~~SHOULD stream a voice note into the player rather than downloading it whole before anything can start.~~ (declined: 26.29)

### Prompts

25.39. MUST play a simple tune, repeating for up to a minute, until the prompt is answered or dismissed, rather than a single short sound.
25.40. MUST NOT depend on the window having focus to deliver a prompt; its purpose is to reach somebody who is looking at something else.
25.41. MUST confirm a settings save inline, without moving the content already on screen.

### Settings

25.42. MUST show a saved-but-hidden value as a disabled field containing a mask, rather than a chip elsewhere on the screen saying it is set.
25.43. MUST explain, when such a field is clicked, that the value is stored and hidden, and offer to clear the group for re-entry. The payment block and the address are separate groups.
25.44. MUST NOT reformat a numeric field while it is being typed into; entering "5" must not become "5.00" with the cursor moved.

### Presentation

25.45. MUST give buttons a hover state that works in dark mode.
25.46. MUST keep the month label a fixed width, so neither arrow moves as the month changes.
25.47. MUST set `user-select: none` on buttons.

## 26. Third review

Written from a session driving the built app. Several items say a previous fix did not
work rather than that it was the wrong fix; those name the earlier item so the two can be
read together.

### Audio

26.1. MUST make the looping background audio start reliably when a timer starts; 25.19's detection is not enough on its own, because in practice it neither plays nor reports anything.
26.2. MUST surface a control for unblocking playback wherever the failure is observable, not only on the settings card.
26.3. MUST NOT stop the loop when the settings screen is opened or left.
26.4. MUST apply the configured volume to playback in every case, including a loop that was already playing when the volume changed.
26.5. MUST disable the Preview control while the loop is supposed to be playing.
26.6. MUST explain, when a disabled Preview is pressed, that audio is believed to be playing, and offer a link to report an issue if it is not.

### Prompts

26.7. MUST stop the prompt tune as soon as the prompt is acknowledged — focusing or clicking the dialog counts — rather than only when a note is saved. Refines 25.39.

### Dialogs

26.8. MUST NOT move focus after a sheet has opened; focus is placed once and then belongs to whoever is typing.
26.9. MUST confirm closing or cancelling a work note that has content.

### Invoices

26.10. ~~MUST NOT offer a download control on the invoice list; see 26.11.~~ (superseded: 27.15)
26.11. MUST label the control "View" and open the document in a large dialog, in an iframe over the blob URL. ~~The browser's own controls are how it is saved; the app does not need to offer that.~~ (superseded: 27.15)
26.12. MUST set an invoice's state from a dropdown rather than from a button per transition.
26.13. MUST NOT warn that issuing freezes the PDF. That is the sensible behaviour and needs no warning; the reverse would.
26.14. MUST NOT describe the per-invoice overrides as what the invoice "says differently": it is not different until it has been made so, which is usually never, and the phrasing is slack. Say what the control is.

### Access

26.15. MUST refuse to revoke the last admin, or to change its role, so the server cannot be left with no administrator.

### Settings

26.16. MUST make the invoice configuration resemble the rendered invoice much more closely than it does. The absence of line items is the one difference that is justified; effort is not. Refines 25.15.
26.17. MUST align the "Ask me sometimes" control with the other controls on its line.

### Notes

26.18. MUST animate the recording waveform continuously. 25.36's fix did not work.

### The timer screen

26.19. MUST size each segment of today's progress bar exactly, with no per-segment minimum. A minimum overall width for the whole bar is acceptable; a minimum per segment is not, because it makes the total wrong. Refines 25.26.
26.20. MUST use the whole screen on the timer page.

### Fourth pass — found while checking the third

26.21. MUST save the invoice PDF and say where it went, in a presentation whose engine cannot display one inline. 26.11's iframe is blank in the desktop window: WebKitGTK draws nothing for a PDF from a blob URL or a data URL while reporting `navigator.pdfViewerEnabled` as true, and an HTML blob in the same iframe loads. Refines 26.11.
26.22. MUST NOT offer a spoken note in a presentation that cannot record one. WebKitGTK has `MediaRecorder`, supports no container at all, and throws `NotSupportedError` from the constructor, so 5.25's "fall back to the browser's default" is the path that fails. Text notes are unaffected, and 5.3 is met by any device that can record.
26.23. MUST check that a loop which was started actually began, and say so when it did not. `play()` resolving means the request was accepted: on WebKitGTK the element then reports `paused: false` with a context in state `running` and a clock that never moves, which is the shape every audio complaint against this app has had. A refusal offers a button; a stall has nothing to offer and must say the true thing instead.
26.24. MUST send a payment field that was emptied on purpose as empty. An untouched masked group is sent nothing and a group unlocked under 25.43 is sent whole, so a box left blank clears the stored value and 24.31 then names it — rather than the document printing a detail from a bank the person has left.
26.25. MUST stop a recording at the length the server will accept and say so, keeping what has been recorded. A note travels as base64 inside a request the server bounds, so speech at 5.27's bitrate reaches the bound in about five minutes — and discovering that by being refused after five minutes of talking loses the recording.
26.26. MUST confirm before a dismissal throws away unsaved work, on every way out of the panel that holds it: a work note still recording, and an invoice with edited lines. `Sheet` already makes backdrop dismissal opt-in for this reason; Escape is the same act.
26.27. MUST say when a list is showing only part of what there is. A screen holding exactly its limit looks like a screen holding everything, so the notes list and the log viewer each say which part they are showing rather than letting a reader conclude the rest is gone.
26.28. MUST refuse to proceed when the frontend and the server disagree about the protocol version, saying which of the two is behind. `hello` has carried the number since there was a protocol and nothing read it; the frontend is a static site, so a browser holding yesterday's build against a server updated this morning is the ordinary case.
26.29. MAY deliver a voice note whole rather than streaming it, declining 25.38. 26.25 bounds a note at what one request carries — about five minutes of speech, some 750 kB — and the server is on the same network as the device asking, so the wait streaming would remove is a fraction of a second. The cost is a second delivery path for audio, with its own ordering and failure cases, for a gain nobody can perceive. If 26.25's bound is ever lifted this should be reconsidered with it.

## 27. Fourth review

From a session driving the built app. Several items are two ends of one fault; they name each other.

### Connection

27.1. MUST discard a previous server's failures once a different address has been entered. Reported as flakiness at startup: the app connects to the address it was given and then reports a disconnection belonging to the server it was pointed at before.

### Audio

27.2. MUST start the loop again when the setting is re-enabled after being turned off, and after a reload in that state. Stopping and starting the timer recovers it, so nothing is broken but the path back.
27.3. MUST show the control for unblocking playback whenever the app believes the loop should be playing and it is not, rather than leaving that state silent. Refines 26.2.
27.4. MUST NOT reach a state where Preview is offered *because* nothing is playing while the timer is running — pressing it starts the loop and then disables itself, which is the app repairing a state it should never have been in. The availability of Preview is evidence the app already knows; 27.3 is what it should do with that.
27.5. MUST name the microphone a recording will use, when that is known, and offer a control — a cog, no words — to inspect it and choose another. Device-local like everything else in section 16.

### Work notes

27.6. MUST let Save stop a running recording and keep it, rather than refusing with "there is nothing here". An explicit Stop stays.
27.7. MUST allow another take after one is finished; "Record again" is offered and there is no way to record another.
27.8. MUST draw the waveform's bars at a uniform width. They vary by a pixel in places, which reads as a fault in the drawing rather than in the sound.
27.9. MUST stop the prompt tune on any interaction with the prompt, not only on the parts of it that happen to take focus. Refines 26.7.
27.10. MUST leave the work-note field empty rather than showing an example of what somebody might write.

### Invoices

27.11. MUST direct somebody to the settings that are missing when the invoices screen cannot produce anything without them.
27.12. MUST keep the line breaks somebody typed into the sender's address, as the client's address already does. The lines are re-wrapped at a different place instead.
27.13. MUST print the note under the totals exactly as it was entered, without adding brackets around it, and MUST NOT describe brackets in the settings copy beside it.
27.14. MUST name a downloaded invoice for the invoice. A blob URL downloads as a uuid.
27.15. MUST offer a Download control in every presentation, named per 27.14 — the browser's own viewer is not available everywhere, and on a phone it does not work at all. Supersedes 26.10 and the second half of 26.11; View stays wherever the engine renders a PDF.

### Pacing and history

27.16. MUST include the running timer in the pacing figures, not only completed entries.
27.17. MUST show a holiday distinctly among the days of the month, and MUST list that month's holidays below them.
27.18. MUST use two spacings on the history screen and mean something by them: the smaller within a group, the larger between. The month's totals and "Add past time" are one group; each run of consecutive days with work is a group.

### Editing an entry

27.19. MUST lay out a timed entry's start and end on one line, and MUST use one component for adding and for editing, since the two disagree today.
27.20. MUST switch between a timed entry and a duration-only one with the same control that chooses the shape when adding, rather than a separate button, and MUST remember the times while the other shape is showing so that switching back restores them. No warning is needed for a change nothing has saved.

### Everywhere

27.21. MUST format a date as `08 Sep 2026` — two-digit day, three-letter month, four-digit year — in the app and in the invoice alike, rather than as `08/09/2026` and rather than through the viewing device's locale.

### Users

27.22. MUST rename the administration screen to "Users" and show it to every role, stating what a device may not see rather than omitting it silently.
27.23. MUST offer an invite from that screen: a dialog explaining what it is, and a QR code carrying this app's own address with the server's KPS address in the URL hash, so that somebody scanning it needs nothing else. The app MUST consume that hash and remove it from the URL once the device is in. This is the one place URL state is wanted; it does not reopen 21.19.

### Installing

27.24. MUST carry the metadata a phone needs to install the frontend as an app.

### Permissions

27.25. MUST run the server and the desktop app with the narrowest Deno permissions that work, rather than with `-A`. Read and write MUST name the directories actually used, and every other permission MUST be justified by something the process does.
27.26. MUST fail visibly rather than silently when a permission is missing: a process that cannot read its data directory should say which permission it needed, since a denied read surfaces as an unrelated error otherwise.

### The dev server

27.27. MUST let the development frontend be served over HTTPS when a certificate has been generated for it, and MUST leave a clone with none behaving exactly as it does now. 24.38 tells somebody on a LAN address to serve over HTTPS or open 127.0.0.1, and on a phone neither was available — so section 23's mobile presentation could only ever be exercised by a narrow viewport rather than by a phone.
27.28. MUST NOT bind the development server to anything but the loopback address by default; exposing it on every interface is a decision for the run, made by forwarding vite's own `--host`.

### Settings that are the person's, not the code's

27.29. A settings card MUST hold only what somebody has changed, over whatever the server currently says. Untouched fields MUST follow the server; a save MUST send the edited fields and nothing else, and MUST NOT be offered when there are none. Every card copied the config at mount and sent all of it back, so a screen left open since before a change was a legitimate writer of the values it had been holding, and reverted them without a word.
27.30. MUST NOT default the work-detail prompt interval. There is no cadence of interruption that is right for a stranger; an unset one MUST read as unset. Prompts MUST NOT be switchable on without one, since a switch that says they are on while none can fire is a lie the code tells on the person's behalf.
27.31. MUST NOT default the monthly target. Ahead and behind are statements about a target, so with none set they MUST NOT be shown at all rather than computed against a number nobody chose. What does not depend on a target — the projection, the hours worked — MUST still be shown.
27.32. MUST NOT default the working week. Where a setting has a truthful neutral value it MAY use it rather than being absent — an empty week schedules nothing and asserts nothing — but the screens MUST distinguish "nothing is set" from "nothing is scheduled" wherever the difference changes what is true, and MUST NOT present a figure derived from a week nobody has declared.
27.33. A default MUST NOT be a guess about the person using the product. This is the rule 24.33, 24.35, 24.36 and 24.37 each found separately, and 27.30–27.32 found three more of: a value that would be right for somebody is not a value that is right for this somebody, and a field holding one cannot say whether it was chosen or assumed. A blank asks.

### Rules that match nothing

27.34. Every rule in the stylesheet MUST match something on some screen of the screenshot walk, or MUST be named as a state that walk does not enter, with the reason written down. A rule that has stopped matching looks exactly like a rule for an unphotographed state, and only one of them is a bug: `.bar > span` matched nothing for several commits after 26.19 moved the segments inside `.bar-fill`, while a check measuring the bar's width stayed green.
