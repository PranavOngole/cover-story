// Cover: a work document. Loaded by index.html with a dynamic import() and
// shown while the real keystrokes go into the hidden buffer.
//
// The notes are original and deliberately ordinary. The company, the project,
// the people named as owners and every date and figure are fictional.
//
// Rendering rules for the text: blank lines separate paragraphs, a line that
// starts with '## ' is a heading, a line that starts with '- ' is a bullet.
// The header's "Last edited just now" is static decoration.
export default {
  id: 'work',
  label: 'A work document',
  tabTitle: 'Q3 planning notes',
  font: 'sans',
  header: { left: 'Q3 planning notes', right: ['last edited'] },
  text: `## Q3 planning notes

Working notes for the dispatch tooling project. Updated after each Tuesday sync. Older items move to the archive page at the end of the quarter.

## Context

The dispatch team still builds the daily run plan in a spreadsheet that is copied forward every morning. The copy step is where most of the errors come from: stale driver availability, vehicles that are off the road for service, and customer windows that changed after the sheet was copied. The goal for the quarter is to replace the copy-forward step with a small internal web page that reads availability from the existing systems and lets the dispatchers edit the plan in one place.

This is not a rewrite of routing. Routing stays manual this quarter. The scope is the plan itself: who drives which vehicle on which run, and the customer windows attached to each run.

## Status by workstream

- Data access: read-only connection to the fleet service table is in place for the test environment. Production access is waiting on the access review (see action items).
- Availability import: driver shift data loads nightly. The weekend file still arrives in a different layout, so Saturday and Sunday runs are being entered by hand until the parser handles both layouts.
- Plan editor: the editable grid works for a single depot. The multi-depot view is sketched but not built.
- Printing: the morning print-out matches the old spreadsheet layout closely enough that the drivers have not asked for changes.
- Training: two dispatchers have used the test version for a full week each. Their notes are on the feedback page.

## What the pilot taught us

Both pilot dispatchers said the editor is faster for small changes and slower for the first fill of the day, because the old spreadsheet carried yesterday's plan forward and the editor starts from the availability data instead. We agreed that starting from yesterday's plan is the right default and that the availability data should flag conflicts rather than block the fill.

The second finding is about vehicle service dates. The fleet table marks a vehicle as unavailable from the day of service, but the depots often take the vehicle off the road the evening before. The editor should treat the evening before as unavailable as well. This is a small rule change, but it would have prevented three of the five conflicts logged during the pilot.

## Risks

- The access review for production data may slip past the end of August. If it does, the September launch moves to October.
- The weekend file layout is owned by a different team and the fix is not on their list yet.
- Only one person on the project knows the print layout code. A second person should pair on it before the launch.
- The depot managers have not seen the multi-depot view and may have expectations that the single-depot version does not meet.

## Action items

- Submit the production access request with the data classification form attached. Owner: Dana Okafor. Due 8 August.
- Write the weekend file parser and test it against the last six weekend files. Owner: Tomasz Wielgus. Due 15 August.
- Change the vehicle availability rule to include the evening before a service date. Owner: Mei Carrow. Due 12 August.
- Pair with Ruben on the print layout for two sessions and write down how it works. Owner: Ada Brenn. Due 22 August.
- Show the single-depot editor to the two depot managers and record what they ask for. Owner: Dana Okafor. Due 20 August.
- Draft the launch note for dispatchers, two paragraphs, no screenshots. Owner: Ruben Haskett. Due 29 August.
- Confirm the archive page for last quarter's notes is linked from the project home. Owner: Ada Brenn. Due 9 August.

## Decisions

- The editor starts each day from yesterday's plan, not from a blank grid. Availability data flags conflicts in place. Agreed 29 July.
- The multi-depot view is out of scope for the quarter. Each depot gets its own page and a shared summary comes later. Agreed 29 July.
- Routing stays manual this quarter. Agreed 15 July, confirmed 29 July.
- The launch date is the first Monday of September if production access is granted by 25 August. Otherwise the first Monday of October. Agreed 5 August.
- We will not build an export back to the spreadsheet. If someone needs the old format, the print-out covers it. Agreed 5 August.

## Open questions

- Who owns the plan once the day has started: the dispatcher who built it, or whoever is on shift? This matters for the edit history.
- Should late customer window changes come in by phone and be typed in, or should the customer service tool write them directly? The second option is cleaner but adds a dependency we did not plan for.
- Do we keep the printed copy at all once the drivers have the page on their phones? The drivers' phones are a separate project and not a safe assumption for September.

## Parking lot

- A color scheme for runs that are more than twenty minutes behind. Nice to have, not for launch.
- Automatic driver suggestions when a run has no driver. Needs the routing work first.
- A read-only view for the customer service desk so they stop phoning dispatch for run status.

## Rollout plan

The launch is a switch of habit more than a switch of software, so the plan is short and leans on the two pilot dispatchers. For the first week both the editor and the old spreadsheet stay available, and the morning print-out comes from the editor. If a dispatcher falls back to the spreadsheet on any day, that counts as a defect and gets written up the same afternoon.

- Week one: pilot dispatchers only, both depots, print-out from the editor. Daily ten-minute check-in at the end of the shift.
- Week two: all dispatchers, spreadsheet still open as a fallback, no new fields.
- Week three: spreadsheet moved to read-only. Anyone who needs it asks Dana.
- End of month: short written review, one page, with the conflict count and the fallback count.

## Notes from the 5 August sync

Attendance: Dana, Tomasz, Mei, Ruben, Ada. Thirty minutes.

Dana walked through the access request process. The form needs the data classification signed by the data owner, which is the fleet team lead, and that person is on leave until 12 August. Dana will ask for a delegate.

Tomasz has the weekend file layout documented and found that the difference is only in the header row and the date format, so the parser change is smaller than expected. He will still test against six files because the earlier ones had a separate problem with blank trailing rows.

Mei raised the evening-before rule and it was accepted without debate. She also noted that two vehicles in the test data have service dates in the past that were never cleared, which is a data quality issue for the fleet team rather than something the editor should hide.

Ruben asked whether the launch note should mention the print-out at all. Agreed that it should, in one sentence, because the dispatchers will look for it on the first morning.

Ada confirmed the pairing sessions and asked for the second one to be recorded so the notes can be checked later.

Next sync is Tuesday 12 August at the usual time. Agenda: access request status, parser test results, and depot manager feedback if the sessions have happened by then.

## Reference

- The test environment address and sign-in steps are on the project home page.
- The feedback page has one section per pilot dispatcher and one for the depot managers.
- The run plan field list is on the data notes page. Changes to it need a line in the decisions section above.`
};
