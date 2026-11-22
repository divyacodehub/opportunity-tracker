/* ==========================================================
   Opportunity Tracker - script.js
   Plain JavaScript, no libraries.

   How the app works (the big idea):
   1. All data lives in ONE array called `applications`.
   2. Every change (add / edit / delete) updates that array,
      saves it to LocalStorage, then calls renderAll().
   3. renderAll() redraws the stats, dashboard previews, deadlines
      page and applications table from that array.
   So the screen is always a reflection of the saved data.
   ========================================================== */

"use strict";

/* ---------- 1. Constants and app state ---------- */

const STORAGE_KEY = "opportunityTracker.applications"; // unchanged, so old data still loads

const TYPES = ["Internship", "Scholarship", "Fellowship", "Other"];
const STATUSES = ["Not Applied", "Applied", "Assessment", "Interview", "Final Round", "Shortlisted", "Selected", "Rejected"];

// Applications still "in progress". Only these appear on the deadline lists.
// (Selected and Rejected are finished, so their deadlines no longer matter.)
const TRACKED_STATUSES = ["Not Applied", "Applied", "Assessment", "Interview", "Final Round", "Shortlisted"];
// Submitted but not yet decided: the "In Progress" stat card and filter group
const IN_PROGRESS_STATUSES = ["Applied", "Assessment", "Interview", "Final Round"];
// The stages shown as steps in the progress tracker (Rejected is shown as a separate end state)
const STAGE_PATH = ["Not Applied", "Applied", "Assessment", "Interview", "Final Round", "Shortlisted", "Selected"];

const URGENT_DAYS = 3;      // 0-3 days left  -> orange "urgent"
const SOON_DAYS = 7;        // 4-7 days left  -> yellow "soon"
const PREVIEW_COUNT = 4;    // deadlines shown on the dashboard
const RECENT_COUNT = 5;     // recent applications shown on the dashboard

// Field length limits (the form enforces these too, and CSV import checks them)
const THEME_KEY = "opportunityTracker.theme";   // remembers light / dark
const UNDO_SECONDS = 7;                          // how long the Undo button stays visible
// Chart colours for each status (the legend also shows the numbers, so colour is never the only clue)
const STATUS_COLORS = {
  "Not Applied": "#94a3b8",
  "Applied": "#3b82f6",
  "Assessment": "#8b5cf6",
  "Interview": "#06b6d4",
  "Final Round": "#e879f9",
  "Shortlisted": "#f59e0b",
  "Selected": "#22c55e",
  "Rejected": "#ef4444"
};
const PRIORITIES = ["High", "Medium", "Low"];
const DEFAULT_PRIORITY = "Medium";               // used when an old record has no priority
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
                     "August", "September", "October", "November", "December"];
const MAX_NAME_LENGTH = 100;
const MAX_NOTES_LENGTH = 500;

const BACKUP_KEY = "opportunityTracker.applications.backup";   // raw copy of the old data, written once before migration
const CORRUPT_KEY = "opportunityTracker.applications.corrupt"; // raw copy of unreadable data
const SEEDED_KEY = "opportunityTracker.demoSeeded";            // set once demo data has been offered, so it is never added again
const NOTIFY_KEY = "opportunityTracker.notifications";         // notification on/off + which reminders were already sent
const DEFAULT_DOCUMENTS = ["Resume/CV", "Cover Letter", "Academic Transcript", "Recommendation Letter", "Portfolio/GitHub", "Other Documents"];
const MAX_DOC_LENGTH = 60;
const MAX_HISTORY_NOTE = 200;
const INTERVIEW_TYPES = ["Online", "Offline", "Technical", "HR", "Other"];
const INTERVIEW_OUTCOMES = ["Pending", "Passed", "Failed", "Cancelled"];
const MAX_ROUND_LENGTH = 60;
const MAX_LOCATION_LENGTH = 300;
const MAX_INTERVIEW_TEXT = 1000;
const DOC_WARNING_DAYS = 7;       // warn about missing documents when the deadline is this close
const NOTIFY_CHECK_MS = 5 * 60 * 1000;

let applications = [];         // the single source of truth
let editingId = null;          // id of the record being edited, or null when adding
let storageAvailable = true;   // set to false if LocalStorage is blocked
let calYear = 0;               // month currently shown on the Calendar page
let calMonth = 0;              // 0 = January ... 11 = December
let heroTarget = null;         // deadline ("YYYY-MM-DD") the Dashboard countdown is counting down to
let calSelected = null;       // "YYYY-MM-DD" of the selected calendar day, or null
let migratedOnLoad = false;    // true when old-format records were upgraded while loading
let corruptOnLoad = false;     // true when saved data could not be parsed
let firstVisit = false;        // true when LocalStorage was readable and held no saved list at all
let detailId = null;           // opportunity shown in the details dialog, or null
let detailTab = "progress";    // progress | documents | interviews
let editingDocId = null;       // checklist item being renamed in the details dialog
let interviewContext = null;   // { id, lockedApp } while the interview form is open; id = interview being edited or null
let confirmAction = null;      // function to run if the confirm dialog is accepted
let returnFocusTo = null;      // element to focus again when a dialog closes


/* ---------- 2. LocalStorage helpers ---------- */

/**
 * Load saved applications from LocalStorage.
 * Returns an empty array if nothing is saved, the data is corrupted,
 * or LocalStorage is unavailable (e.g. blocked in private mode).
 */
function loadApplications() {
  migratedOnLoad = false;
  corruptOnLoad = false;
  firstVisit = false;
  let savedText = null;
  try {
    savedText = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    storageAvailable = false;
    console.warn("Could not read from LocalStorage:", error);
    return [];
  }
  if (savedText === null) { firstVisit = true; return []; }   // the key does not exist yet: a brand-new visitor
  if (!savedText) return [];

  let parsed;
  try {
    parsed = JSON.parse(savedText);
  } catch (error) {
    corruptOnLoad = true;
    keepRawCopy(CORRUPT_KEY, savedText);   // never lose unreadable data silently
    return [];
  }
  if (!Array.isArray(parsed)) {
    corruptOnLoad = true;
    keepRawCopy(CORRUPT_KEY, savedText);
    return [];
  }

  // Old records (before stages, checklists and interviews) lack the new fields.
  const records = parsed.map(normalizeRecord).filter(Boolean);
  migratedOnLoad = records.length !== parsed.length || !parsed.every(isCleanRecord);
  if (migratedOnLoad) keepRawCopy(BACKUP_KEY, savedText);   // one-time safety copy of the old format
  return records;
}

/** Store a raw text copy under `key` unless one already exists. Failures are ignored. */
function keepRawCopy(key, text) {
  try {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, text);
  } catch (error) { /* storage full or blocked: nothing more we can do */ }
}

/** Save the current applications array to LocalStorage. */
function saveApplications() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
  } catch (error) {
    storageAvailable = false;
    console.warn("Could not save to LocalStorage:", error);
    showToast("Could not save to this browser. Changes will be lost on refresh.", "error");
  }
}

/** Basic check that a loaded record has the fields we rely on. */
function isValidRecord(record) {
  return (
    record &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.organisation === "string" &&
    typeof record.type === "string" &&
    typeof record.deadline === "string" &&
    typeof record.status === "string"
  );
}


/* ---------- 3. Date helpers ---------- */

/**
 * Convert "YYYY-MM-DD" into a Date at local midnight.
 * (new Date("2026-05-01") would be treated as UTC and can shift the day,
 *  so we build the date from its parts instead.)
 */
function parseDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Today's date at local midnight. */
function getToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Whole days from today until the deadline (negative = already passed). */
function daysUntil(dateString, today = getToday()) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseDate(dateString) - today) / millisecondsPerDay);
}

/** Format "2026-05-01" as "1 May 2026". */
function formatDate(dateString) {
  return parseDate(dateString).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric"
  });
}

/** Check a string is a real calendar date in YYYY-MM-DD form. */
function isRealDate(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return false;
  const date = parseDate(dateString);
  const [year, month, day] = dateString.split("-").map(Number);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}


/* ---------- 3b. Data model: stage history, documents, interviews ---------- */

/*
   Every record is { id, name, organisation, type, deadline, status, link, notes, priority,
                     history:    [{ id, status, date, note }]   oldest first; date is "YYYY-MM-DD" or null
                     documents:  [{ id, label, done }]
                     interviews: [{ id, date, time, round, type, location, prep, questions, outcome, feedback }] }
   Records saved by older versions lack the last three fields; normalizeRecord() adds them.
*/

const isText = (value) => typeof value === "string";
const clip = (value, max) => (isText(value) ? value.trim().slice(0, max) : "");

/** Short unique id for history entries, documents and interviews. */
function makeId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function normalizeHistory(history, currentStatus) {
  const entries = [];
  if (Array.isArray(history)) {
    history.forEach(item => {
      if (!item || !isText(item.status) || item.status === "") return;
      entries.push({
        id: isText(item.id) && SAFE_ID.test(item.id) ? item.id : makeId("h"),
        status: item.status,
        date: isText(item.date) && isRealDate(item.date) ? item.date : null,
        note: clip(item.note, MAX_HISTORY_NOTE)
      });
    });
  }
  // The newest entry must match the record's current status (also covers records with no history)
  if (entries.length === 0 || entries[entries.length - 1].status !== currentStatus) {
    entries.push({ id: makeId("h"), status: currentStatus, date: null, note: "" });
  }
  return entries;
}

function createDefaultDocuments() {
  return DEFAULT_DOCUMENTS.map(label => ({ id: makeId("d"), label, done: false }));
}

function normalizeDocuments(documents) {
  if (!Array.isArray(documents)) return createDefaultDocuments();   // never set up: start with the standard six
  const seen = new Set();
  const result = [];
  documents.forEach(item => {
    const label = item && clip(item.label, MAX_DOC_LENGTH);
    if (!label || seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    result.push({ id: isText(item.id) && SAFE_ID.test(item.id) ? item.id : makeId("d"), label, done: item.done === true });
  });
  return result;
}

function normalizeInterviews(interviews) {
  if (!Array.isArray(interviews)) return [];
  const result = [];
  interviews.forEach(item => {
    if (!item || !isText(item.date) || !isRealDate(item.date)) return;
    const round = clip(item.round, MAX_ROUND_LENGTH);
    if (!round) return;
    result.push({
      id: isText(item.id) && SAFE_ID.test(item.id) ? item.id : makeId("i"),
      date: item.date,
      time: isText(item.time) && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) ? item.time : "",
      round,
      type: INTERVIEW_TYPES.includes(item.type) ? item.type : "Other",
      location: clip(item.location, MAX_LOCATION_LENGTH),
      prep: clip(item.prep, MAX_INTERVIEW_TEXT),
      questions: clip(item.questions, MAX_INTERVIEW_TEXT),
      outcome: INTERVIEW_OUTCOMES.includes(item.outcome) ? item.outcome : "Pending",
      feedback: clip(item.feedback, MAX_INTERVIEW_TEXT)
    });
  });
  return result;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Does a saved record already match the current format and safety rules? (If not, loading upgrades it.) */
function isCleanRecord(raw) {
  return isValidRecord(raw) && SAFE_ID.test(raw.id) && STATUSES.includes(raw.status) && TYPES.includes(raw.type) &&
    isRealDate(raw.deadline) && (!raw.link || (isText(raw.link) && isValidUrl(raw.link))) &&
    Array.isArray(raw.history) && Array.isArray(raw.documents) && Array.isArray(raw.interviews);
}

/**
 * Return a complete, safe copy of a saved record, or null if it is unusable. Never throws.
 * Saved data is treated as untrusted: ids must be plain, status/type must be known values,
 * the deadline must be a real date and the link must be http(s), otherwise a safe default is used.
 */
function normalizeRecord(raw) {
  if (!isValidRecord(raw) || !isRealDate(raw.deadline)) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : "Not Applied";
  raw = { ...raw, status };
  return {
    ...raw,
    id: SAFE_ID.test(raw.id) ? raw.id : makeId("r"),
    type: TYPES.includes(raw.type) ? raw.type : "Other",
    link: isText(raw.link) && isValidUrl(raw.link) ? raw.link : "",
    notes: isText(raw.notes) ? raw.notes : "",
    ...(raw.demo === true ? { demo: true } : { demo: undefined }),
    history: normalizeHistory(raw.history, raw.status),
    documents: normalizeDocuments(raw.documents),
    interviews: normalizeInterviews(raw.interviews)
  };
}

/** A fresh record from validated form values; its history starts with the chosen status today. */
function createRecord(values, todayIso) {
  return normalizeRecord({
    id: generateId(),
    ...values,
    history: [{ id: makeId("h"), status: values.status, date: todayIso, note: "" }]
  });
}

/**
 * Move an opportunity to a new stage and record it in its history.
 * Returns { ok: true } or { ok: false, error }. Nothing changes on failure.
 */
function applyStageChange(app, newStatus, dateIso, note, todayIso) {
  if (!STATUSES.includes(newStatus)) return { ok: false, error: "Please choose a stage." };
  if (newStatus === app.status) return { ok: false, error: "The opportunity is already in this stage." };
  if (!dateIso || !isRealDate(dateIso)) return { ok: false, error: "Please enter a valid date." };
  if (dateIso > todayIso) return { ok: false, error: "The date cannot be in the future." };
  const cleanNote = clip(note, MAX_HISTORY_NOTE + 1);
  if (cleanNote.length > MAX_HISTORY_NOTE) return { ok: false, error: "Note must be " + MAX_HISTORY_NOTE + " characters or fewer." };

  const lastDated = app.history.filter(entry => entry.date).pop();
  if (lastDated && dateIso < lastDated.date) {
    return { ok: false, error: "The date cannot be earlier than the previous change (" + formatDate(lastDated.date) + ")." };
  }
  app.history.push({ id: makeId("h"), status: newStatus, date: dateIso, note: cleanNote });
  app.status = newStatus;
  return { ok: true };
}

/** Steps for the progress tracker: [{ status, state }], state = done | current | skipped | todo. */
function getStepperSteps(app) {
  const reached = new Set(app.history.map(entry => entry.status));
  reached.add(app.status);
  let highest = -1;
  STAGE_PATH.forEach((stage, index) => { if (reached.has(stage)) highest = index; });

  const steps = STAGE_PATH.map((status, index) => {
    let state = "todo";
    if (status === app.status) state = "current";
    else if (reached.has(status)) state = "done";
    else if (index === 0 && highest > 0) state = "done";   // an old record may never have logged "Not Applied"
    else if (index < highest) state = "skipped";
    return { status, state };
  });
  if (reached.has("Rejected")) steps.push({ status: "Rejected", state: app.status === "Rejected" ? "current" : "done" });
  return steps;
}

/** Has this opportunity ever left "Not Applied"? */
function hasSubmitted(app) {
  return app.status !== "Not Applied" || app.history.some(entry => entry.status !== "Not Applied");
}

/** Has it ever been shortlisted (now, or earlier in its history)? */
function hasBeenShortlisted(app) {
  return ["Shortlisted", "Selected"].includes(app.status) || app.history.some(entry => entry.status === "Shortlisted");
}

/** The date (YYYY-MM-DD) the application was first submitted, or null if unknown. */
function getSubmissionDate(app) {
  const entry = app.history.find(item => item.status !== "Not Applied" && item.date);
  return entry ? entry.date : null;
}

/* ----- Document checklist ----- */

function getDocumentProgress(app) {
  const total = app.documents.length;
  const done = app.documents.filter(doc => doc.done).length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Validate a checklist item name. `ignoreId` lets a rename keep its own name. Returns an error or "". */
function validateDocumentLabel(app, label, ignoreId) {
  const text = (label || "").trim();
  if (!text) return "Enter a document name.";
  if (text.length > MAX_DOC_LENGTH) return "Name must be " + MAX_DOC_LENGTH + " characters or fewer.";
  const clash = app.documents.some(doc => doc.id !== ignoreId && doc.label.toLowerCase() === text.toLowerCase());
  return clash ? "That document is already on the list." : "";
}

/** A warning when the application is not sent yet, documents are missing and the deadline is close. */
function getDocumentWarning(app, today = getToday()) {
  if (app.status !== "Not Applied") return null;
  const { done, total } = getDocumentProgress(app);
  const days = daysUntil(app.deadline, today);
  if (total === 0 || done === total || days < 0 || days > DOC_WARNING_DAYS) return null;
  const missing = total - done;
  return { missing, days, text: missing + (missing === 1 ? " document" : " documents") + " still to prepare, " + daysLabel(days).toLowerCase() };
}

/* ----- Interviews ----- */

function validateInterview(values, app, editingInterviewId) {
  const errors = {};
  if (!values.date) errors.date = "Interview date is required.";
  else if (!isRealDate(values.date)) errors.date = "Please enter a valid date.";
  if (values.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time)) errors.time = "Enter the time as HH:MM.";
  if (!values.round) errors.round = "Round name is required (for example Round 1).";
  else if (values.round.length > MAX_ROUND_LENGTH) errors.round = "Round must be " + MAX_ROUND_LENGTH + " characters or fewer.";
  else if (app && app.interviews.some(item => item.id !== editingInterviewId && item.round.toLowerCase() === values.round.toLowerCase())) {
    errors.round = "This opportunity already has a round called \"" + values.round + "\".";
  }
  if (!INTERVIEW_TYPES.includes(values.type)) errors.type = "Please choose a type.";
  if (!INTERVIEW_OUTCOMES.includes(values.outcome)) errors.outcome = "Please choose an outcome.";
  if (values.location.length > MAX_LOCATION_LENGTH) errors.location = "Link or location must be " + MAX_LOCATION_LENGTH + " characters or fewer.";
  ["prep", "questions", "feedback"].forEach(key => {
    if (values[key].length > MAX_INTERVIEW_TEXT) errors[key] = "Must be " + MAX_INTERVIEW_TEXT + " characters or fewer.";
  });
  return errors;
}

/** Every interview as { app, interview }, oldest first. */
function getAllInterviews(list) {
  const all = [];
  list.forEach(app => app.interviews.forEach(interview => all.push({ app, interview })));
  all.sort((a, b) => (a.interview.date + " " + (a.interview.time || "99:99")).localeCompare(b.interview.date + " " + (b.interview.time || "99:99")));
  return all;
}

/**
 * Split interviews into upcoming (today or later, still pending) and past (everything else).
 * Upcoming is soonest first; past is most recent first.
 */
function splitInterviews(list, todayIso) {
  const all = getAllInterviews(list);
  const upcoming = all.filter(x => x.interview.date >= todayIso && x.interview.outcome === "Pending");
  const past = all.filter(x => !upcoming.includes(x)).reverse();
  return { upcoming, past };
}

/* ----- Reminders and notifications ----- */

/** Group in-progress deadlines for the dashboard reminder panel. */
function getReminderBuckets(list, today = getToday()) {
  const buckets = { overdue: [], today: [], tomorrow: [], within3: [], within7: [] };
  list.filter(isTracked)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .forEach(app => {
      const days = daysUntil(app.deadline, today);
      if (days < 0) buckets.overdue.push(app);
      else if (days === 0) buckets.today.push(app);
      else if (days === 1) buckets.tomorrow.push(app);
      else if (days <= 3) buckets.within3.push(app);
      else if (days <= 7) buckets.within7.push(app);
    });
  return buckets;
}

/** Which reminder step (7, 3, 1 days, today, overdue) a deadline is in, or null if it is further away. */
function getNotificationStep(days) {
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 1) return "1-day";
  if (days <= 3) return "3-day";
  if (days <= 7) return "7-day";
  return null;
}

/**
 * Reminders that should be sent now: one per deadline per step, never repeated.
 * `sent` maps "id|deadline|step" to the date it was sent. Returns [{ key, app, days, step }].
 */
function getNotificationsDue(list, today, sent) {
  const due = [];
  list.filter(isTracked).forEach(app => {
    const days = daysUntil(app.deadline, today);
    const step = getNotificationStep(days);
    if (!step) return;
    const key = app.id + "|" + app.deadline + "|" + step;
    if (!(sent && sent[key])) due.push({ key, app, days, step });
  });
  return due;
}

/* ----- Analytics ----- */

/** Percentage with one decimal ("33.3%"), or "—" when there is nothing to divide by. */
function formatRate(part, whole) {
  return whole === 0 ? "—" : (Math.round((part / whole) * 1000) / 10).toFixed(1) + "%";
}

/** All analytics figures, calculated from the saved records only. */
function getAnalytics(list, today = getToday()) {
  const total = list.length;
  const submittedList = list.filter(hasSubmitted);
  const submitted = submittedList.length;
  const shortlisted = list.filter(hasBeenShortlisted).length;
  const selected = list.filter(app => app.status === "Selected").length;
  const rejected = list.filter(app => app.status === "Rejected").length;

  // Last 6 calendar months, oldest first, counted by the date each application was submitted
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    months.push({ key, label: MONTH_NAMES[d.getMonth()].slice(0, 3) + " " + String(d.getFullYear()).slice(2), count: 0 });
  }
  let undated = 0, earlier = 0;
  submittedList.forEach(app => {
    const date = getSubmissionDate(app);
    if (!date) { undated++; return; }
    const month = months.find(m => m.key === date.slice(0, 7));
    if (month) month.count++; else earlier++;
  });

  const byType = TYPES.map(type => {
    const count = list.filter(app => app.type === type).length;
    return { label: type, count, percent: total === 0 ? 0 : Math.round((count / total) * 1000) / 10 };
  });

  const groups = new Map();
  list.forEach(app => {
    const key = app.organisation.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, { label: app.organisation.trim(), count: 0 });
    groups.get(key).count++;
  });
  const orgs = [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    total, submitted, shortlisted, selected, rejected,
    shortlistingRate: formatRate(shortlisted, submitted),
    selectionRate: formatRate(selected, submitted),
    months, undated, earlier, byType,
    byOrganisation: orgs.slice(0, 8),
    moreOrganisations: Math.max(0, orgs.length - 8)
  };
}


/* ----- Demo data for a first visit ----- */

/** Date `offset` days from `today`, as YYYY-MM-DD. */
function isoOffset(today, offset) {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/**
 * Seven fictional example opportunities, flagged demo:true. All dates are offsets from `today`
 * (the visitor's first-visit date), so the deadlines stay upcoming instead of going out of date.
 * Organisations and roles are invented and are not real openings.
 */
function buildDemoOpportunities(today = getToday()) {
  const day = (n) => isoOffset(today, n);
  const step = (status, offset, note) => ({ id: makeId("h"), status, date: day(offset), note: note || "" });
  const docs = (ready) => DEFAULT_DOCUMENTS.map((label, i) => ({ id: makeId("d"), label, done: i < ready }));
  const talk = (o) => ({ id: makeId("i"), time: "", location: "", prep: "", questions: "", feedback: "", outcome: "Pending", type: "Online", ...o });
  const note = "Demo data: a fictional example, not a real opening.";

  const raw = [
    { name: "Backend Engineering Intern", organisation: "Northwind Labs", type: "Internship", deadline: day(2), status: "Not Applied", priority: "High",
      link: "https://example.com/northwind-backend-intern", notes: note + " Finish the cover letter and portfolio links.",
      history: [step("Not Applied", -12)], documents: docs(3), interviews: [] },
    { name: "Frontend Intern", organisation: "Brightside Software", type: "Internship", deadline: day(6), status: "Interview", priority: "High",
      link: "https://example.com/brightside-frontend-intern", notes: note + " Technical round next; revise DOM events and CSS layout.",
      history: [step("Not Applied", -40), step("Applied", -33), step("Assessment", -20, "Online coding test"), step("Interview", -6, "HR screen booked")], documents: docs(6),
      interviews: [
        talk({ date: day(-5), time: "11:00", round: "HR Screen", type: "HR", outcome: "Passed", location: "https://meet.example.com/brightside-hr", feedback: "Friendly chat about projects and teamwork." }),
        talk({ date: day(2), time: "15:00", round: "Technical Round", type: "Technical", location: "https://meet.example.com/brightside-tech", prep: "Revise closures, event delegation and flexbox/grid. Prepare one project walkthrough." })
      ] },
    { name: "Merit Scholarship", organisation: "Lakeview Foundation", type: "Scholarship", deadline: day(9), status: "Shortlisted", priority: "Medium",
      link: "https://example.com/lakeview-merit-scholarship", notes: note + " Panel interview on campus.",
      history: [step("Applied", -50), step("Shortlisted", -15, "Shortlist email received")], documents: docs(4),
      interviews: [talk({ date: day(5), time: "10:00", round: "Panel Interview", type: "Offline", location: "Room 4, Lakeview Campus", prep: "Bring original transcripts and two reference letters." })] },
    { name: "Open Source Fellowship", organisation: "Civic Code Trust", type: "Fellowship", deadline: day(18), status: "Applied", priority: "Medium",
      link: "https://example.com/civic-code-fellowship", notes: note + " Waiting for the first screening result.",
      history: [step("Applied", -9, "Submitted proposal")], documents: docs(5), interviews: [] },
    { name: "Research Assistant", organisation: "Orbit Institute", type: "Other", deadline: day(25), status: "Final Round", priority: "Low",
      link: "", notes: note + " Final interview done; waiting to record the outcome.",
      history: [step("Applied", -22), step("Interview", -14), step("Final Round", -3, "Invited to the final interview")], documents: docs(2),
      interviews: [talk({ date: day(-3), time: "14:00", round: "Final Interview", type: "Online", location: "https://meet.example.com/orbit-final", prep: "Re-read the lab's recent papers." })] },
    { name: "Cloud Intern", organisation: "Northwind Labs", type: "Internship", deadline: day(-15), status: "Rejected", priority: "Medium",
      link: "", notes: note + " Closed: not selected after the assessment.",
      history: [step("Applied", -60), step("Assessment", -48), step("Rejected", -35, "Not selected after the assessment")], documents: docs(6), interviews: [] },
    { name: "Data Platform Intern", organisation: "Brightside Software", type: "Internship", deadline: day(-8), status: "Selected", priority: "High",
      link: "", notes: note + " Offer accepted.",
      history: [step("Applied", -100), step("Interview", -70), step("Shortlisted", -45), step("Selected", -12, "Offer received")], documents: docs(6),
      interviews: [talk({ date: day(-68), time: "10:30", round: "Round 1", type: "Technical", outcome: "Passed", feedback: "SQL and data modelling questions went well." })] }
  ];
  return raw.map((item, i) => normalizeRecord({ ...item, id: "demo-" + (i + 1), demo: true })).filter(Boolean);
}

/* ---------- 4. Validation ---------- */

/** Allow only http:// or https:// links. */
function isValidUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}

/**
 * Validate form values.
 * Returns an object of error messages keyed by field; empty object = valid.
 */
function validateForm(values) {
  const errors = {};

  if (!values.name) errors.name = "Opportunity name is required.";
  else if (values.name.length < 2) errors.name = "Name must be at least 2 characters.";
  else if (values.name.length > MAX_NAME_LENGTH) errors.name = "Name must be " + MAX_NAME_LENGTH + " characters or fewer.";

  if (!values.organisation) errors.organisation = "Organisation name is required.";
  else if (values.organisation.length > MAX_NAME_LENGTH) errors.organisation = "Organisation must be " + MAX_NAME_LENGTH + " characters or fewer.";

  if (!TYPES.includes(values.type)) errors.type = "Please choose a type.";

  if (!values.deadline) errors.deadline = "Deadline is required.";
  else if (!isRealDate(values.deadline)) errors.deadline = "Please enter a valid date.";

  // The link is optional, but if provided it must be a valid URL
  if (values.link && !isValidUrl(values.link)) {
    errors.link = "Enter a valid link starting with http:// or https://";
  }

  if (!STATUSES.includes(values.status)) errors.status = "Please choose a status.";

  // Priority is optional (blank = Medium), but if given it must be one of the allowed values
  if (values.priority && !PRIORITIES.includes(values.priority)) {
    errors.priority = "Please choose High, Medium or Low.";
  }

  // Notes are optional, but limited in length
  if (values.notes && values.notes.length > MAX_NOTES_LENGTH) {
    errors.notes = "Notes must be " + MAX_NOTES_LENGTH + " characters or fewer.";
  }

  return errors;
}


/* ---------- 5. Data logic (pure functions, no DOM) ---------- */

/** Count applications by status for the dashboard. */
function calculateStats(list) {
  return {
    total: list.length,
    notApplied: list.filter(a => a.status === "Not Applied").length,
    applied: list.filter(a => a.status === "Applied").length,
    inProgress: list.filter(a => IN_PROGRESS_STATUSES.includes(a.status)).length,
    shortlisted: list.filter(a => a.status === "Shortlisted").length,
    selected: list.filter(a => a.status === "Selected").length,
    rejected: list.filter(a => a.status === "Rejected").length
  };
}

/**
 * Apply search text, type filter, status filter and deadline sorting.
 * Returns a NEW array; the original is not changed.
 */
function getVisibleApplications(list, filters) {
  const searchText = filters.search.trim().toLowerCase();

  const filtered = list.filter(app => {
    const matchesSearch =
      app.name.toLowerCase().includes(searchText) ||
      app.organisation.toLowerCase().includes(searchText);
    const matchesType = filters.type === "all" || app.type === filters.type;
    const matchesStatus = filters.status === "all" || app.status === filters.status ||
      (filters.status === "in-progress" && IN_PROGRESS_STATUSES.includes(app.status));
    const matchesPriority = !filters.priority || filters.priority === "all" || getPriority(app) === filters.priority;
    return matchesSearch && matchesType && matchesStatus && matchesPriority;
  });

  // ISO dates (YYYY-MM-DD) sort correctly as plain text
  filtered.sort((a, b) => a.deadline.localeCompare(b.deadline));
  if (filters.sort === "desc") filtered.reverse();
  // Priority sort: High first; the earlier deadline-sort order is kept inside each group
  if (filters.sort === "priority") {
    filtered.sort((a, b) => PRIORITIES.indexOf(getPriority(a)) - PRIORITIES.indexOf(getPriority(b)));
  }
  return filtered;
}

/** The record's priority; older records saved without one count as Medium. */
function getPriority(app) {
  return PRIORITIES.includes(app.priority) ? app.priority : DEFAULT_PRIORITY;
}

/** Is this application still in progress (so its deadline matters)? */
function isTracked(app) {
  return TRACKED_STATUSES.includes(app.status);
}

/** Tracked applications whose deadline is today or later, nearest first. */
function getUpcomingDeadlines(list, today = getToday()) {
  return list
    .filter(app => isTracked(app) && daysUntil(app.deadline, today) >= 0)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
}

/** Tracked applications whose deadline has passed, most recently missed first. */
function getOverdueDeadlines(list, today = getToday()) {
  return list
    .filter(app => isTracked(app) && daysUntil(app.deadline, today) < 0)
    .sort((a, b) => b.deadline.localeCompare(a.deadline));
}

/** The newest applications first (new records are added to the end of the array). */
function getRecentApplications(list, count) {
  return list.slice(-count).reverse();
}

/** Turn a day count into readable text, e.g. "3 days left" or "Overdue by 2 days". */
function daysLabel(days) {
  if (days < 0) {
    const overdueDays = -days;
    return "Overdue by " + overdueDays + (overdueDays === 1 ? " day" : " days");
  }
  if (days === 0) return "Due today";
  if (days === 1) return "1 day left";
  return days + " days left";
}

/** Group a day count into a colour level: overdue, urgent, soon or ok. */
function getDeadlineUrgency(days) {
  if (days < 0) return "overdue";
  if (days <= URGENT_DAYS) return "urgent";
  if (days <= SOON_DAYS) return "soon";
  return "ok";
}

/**
 * Small label shown next to the deadline in the applications table.
 * Returns null when no label is needed (finished applications or far-off deadlines).
 */
function getDeadlineIndicator(app, today = getToday()) {
  if (!isTracked(app)) return null;

  const days = daysUntil(app.deadline, today);
  const urgency = getDeadlineUrgency(days);
  if (urgency === "ok") return null;
  return { text: daysLabel(days), urgency: urgency };
}

/** How many in-progress opportunities are due within the next `days` days (today included)? */
/**
 * Count opportunities per status for the chart.
 * Returns one entry per status: { status, count, percent } (percent is rounded).
 */
function getStatusSegments(list) {
  const total = list.length;
  return STATUSES.map(status => {
    const count = list.filter(app => app.status === status).length;
    return { status, count, percent: total === 0 ? 0 : Math.round((count / total) * 100) };
  });
}

/**
 * Build the cells for one month of the calendar (weeks start on Sunday).
 * Returns a flat array whose length is a multiple of 7. Each cell:
 *   { iso, day, inMonth, isToday, items }   items = applications due that day
 * `month` is 0-11. Days from the neighbouring months fill the first and last week.
 */
function buildCalendarMonth(year, month, list, todayIso) {
  const pad = (n) => String(n).padStart(2, "0");
  const startOffset = new Date(year, month, 1).getDay();          // 0 = Sunday
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cellCount = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const cells = [];
  for (let i = 0; i < cellCount; i++) {
    const date = new Date(year, month, 1 - startOffset + i);      // JavaScript fixes day overflow for us
    const iso = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
    cells.push({
      iso,
      day: date.getDate(),
      inMonth: date.getMonth() === month,
      isToday: iso === todayIso,
      items: list.filter(app => app.deadline === iso).sort((a, b) => a.name.localeCompare(b.name))
    });
  }
  return cells;
}

/* ----- Calendar file (.ics) for Google Calendar, Outlook, Apple Calendar ----- */

/** Escape text for an .ics file: backslash, semicolon, comma and line breaks. */
function icsEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** .ics lines should be at most 75 characters; longer ones continue on the next line after a space. */
function icsFold(line) {
  const parts = [line.slice(0, 75)];
  for (let rest = line.slice(75); rest.length > 0; rest = rest.slice(74)) {
    parts.push(" " + rest.slice(0, 74));
  }
  return parts.join("\r\n");
}

/**
 * Turn a list of applications into .ics text: one all-day event per deadline,
 * each with a reminder one day before. `stamp` looks like 20261231T120000Z.
 */
function applicationsToIcs(list, stamp) {
  const pad = (n) => String(n).padStart(2, "0");
  const compact = (date) => date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Opportunity Tracker//EN", "CALSCALE:GREGORIAN"];
  list.forEach(app => {
    const start = parseDate(app.deadline);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);   // all-day events end the next day
    const details = [app.organisation, app.type, app.status];
    if (app.link) details.push(app.link);
    if (app.notes) details.push(app.notes);

    lines.push(
      "BEGIN:VEVENT",
      "UID:" + app.id + "@opportunity-tracker",
      "DTSTAMP:" + stamp,
      "DTSTART;VALUE=DATE:" + compact(start),
      "DTEND;VALUE=DATE:" + compact(end),
      "SUMMARY:" + icsEscape("Deadline: " + app.name),
      "DESCRIPTION:" + icsEscape(details.join(" | ")),
      "BEGIN:VALARM",
      "TRIGGER:-P1D",
      "ACTION:DISPLAY",
      "DESCRIPTION:Deadline tomorrow",
      "END:VALARM",
      "END:VEVENT"
    );
  });
  lines.push("END:VCALENDAR");
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

/** The tracked opportunity whose deadline comes up next (today counts), or null. */
function getNextDeadline(list, today = getToday()) {
  return getUpcomingDeadlines(list, today)[0] || null;
}

/**
 * Time left until the END of a deadline day (local midnight after it).
 * Returns { days, hours, minutes, seconds, totalMs }; never negative.
 */
function getCountdownParts(deadlineIso, nowMs) {
  const day = parseDate(deadlineIso);
  const endMs = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const totalMs = Math.max(0, endMs - nowMs);
  const DAY = 86400000, HOUR = 3600000, MINUTE = 60000;
  return {
    days: Math.floor(totalMs / DAY),
    hours: Math.floor((totalMs % DAY) / HOUR),
    minutes: Math.floor((totalMs % HOUR) / MINUTE),
    seconds: Math.floor((totalMs % MINUTE) / 1000),
    totalMs
  };
}

function countDueWithin(list, days, today = getToday()) {
  return list.filter(app => {
    const left = daysUntil(app.deadline, today);
    return isTracked(app) && left >= 0 && left <= days;
  }).length;
}

/** Create a reasonably unique id for a new record. */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Today as "YYYY-MM-DD" in the user's own time zone (used for the export file name). */
function getTodayIso() {
  const t = getToday();
  const pad = (n) => String(n).padStart(2, "0");
  return t.getFullYear() + "-" + pad(t.getMonth() + 1) + "-" + pad(t.getDate());
}


/* ---------- 5b. CSV export and import (pure functions, no DOM) ---------- */

/*
  CSV = "comma separated values": a plain text table that opens in Excel.
  Columns, in this order:  Name, Organisation, Type, Deadline, Status, Link, Notes, Priority
  Deadline format is YYYY-MM-DD (for example 2026-12-31).
*/
const CSV_COLUMNS = ["Name", "Organisation", "Type", "Deadline", "Status", "Link", "Notes", "Priority"];
const CSV_REQUIRED_COLUMNS = ["name", "organisation", "type", "deadline", "status"];
const MAX_IMPORT_BYTES = 1024 * 1024;   // refuse files bigger than 1 MB
const MAX_IMPORT_ROWS = 2000;           // refuse files with more than 2000 data rows

/*
  Spreadsheet safety: Excel treats a cell that starts with = + - or @ as a formula,
  which can be abused. On export we put a ' in front of such text so it stays plain
  text, and on import we remove that ' again so the data round-trips unchanged.
*/
function protectFromFormula(text) {
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}
function undoFormulaProtection(text) {
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
}

/** Wrap a value in quotes if it contains a comma, quote or line break. */
function csvCell(value) {
  const text = protectFromFormula(String(value == null ? "" : value));
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** Turn the applications array into CSV text (header row + one row per record). */
function applicationsToCsv(list) {
  const rows = list.map(app =>
    [app.name, app.organisation, app.type, app.deadline, app.status, app.link || "", app.notes || "", getPriority(app)]
      .map(csvCell).join(",")
  );
  return [CSV_COLUMNS.join(",")].concat(rows).join("\r\n") + "\r\n";
}

/**
 * Split CSV text into rows of cells. Handles quoted cells that contain commas,
 * doubled quotes ("") and line breaks, plus Windows (\r\n) and Unix (\n) endings.
 * Returns { rows, unclosedQuote }.
 */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // remove the Excel "BOM" marker

  const rows = [];
  let row = [];
  let cell = "";
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (insideQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }   // "" means one literal quote
        else insideQuotes = false;                        // closing quote
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      insideQuotes = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;      // treat \r\n as one line break
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }

  return { rows: rows, unclosedQuote: insideQuotes };
}

/** Case-insensitive match against a list of allowed values; returns the proper spelling or the original text. */
function matchAllowedValue(text, allowed) {
  const found = allowed.find(item => item.toLowerCase() === text.toLowerCase());
  return found || text;
}

/** Two records are duplicates if name, organisation, type and deadline all match. */
function duplicateKey(item) {
  return [item.name, item.organisation, item.type, item.deadline].join("|").toLowerCase();
}

/**
 * Validate CSV text and work out which rows can be imported.
 * Nothing is saved here. Returns:
 *   { fatal, added, skipped, duplicates }
 *   fatal      - text explaining why the WHOLE file was rejected, or null
 *   added      - valid new records (with fresh ids)
 *   skipped    - [{ row, reason }] rows that failed validation
 *   duplicates - number of rows ignored because the same opportunity already exists
 */
function importFromCsv(text, existingList) {
  const result = { fatal: null, added: [], skipped: [], duplicates: 0 };

  const parsed = parseCsv(text);
  if (parsed.unclosedQuote) {
    result.fatal = "The file has a quote (\") that is never closed, so it cannot be read.";
    return result;
  }

  // Ignore completely blank lines
  const rows = parsed.rows.filter(row => row.some(cell => cell.trim() !== ""));
  if (rows.length === 0) {
    result.fatal = "The file is empty.";
    return result;
  }

  // The first row must be a header containing the required columns
  const header = rows[0].map(cell => cell.trim().toLowerCase());
  const missing = CSV_REQUIRED_COLUMNS.filter(name => !header.includes(name));
  if (missing.length > 0) {
    result.fatal = "Missing required column(s): " + missing.join(", ") + ".";
    return result;
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    result.fatal = "The file has a header row but no opportunities.";
    return result;
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    result.fatal = "The file has " + dataRows.length + " rows. The limit is " + MAX_IMPORT_ROWS + ".";
    return result;
  }

  const column = (name) => header.indexOf(name);
  const seenKeys = new Set(existingList.map(duplicateKey));

  dataRows.forEach((row, index) => {
    const rowNumber = index + 1;   // "Row 1" = first opportunity after the header

    // More cells than headers usually means a comma inside an unquoted value
    if (row.length > header.length) {
      result.skipped.push({ row: rowNumber, reason: "Row has more columns than the header (is a comma missing quotes?)." });
      return;
    }

    const read = (name) => {
      const position = column(name);
      return position === -1 ? "" : undoFormulaProtection((row[position] || "").trim());
    };

    const values = {
      name: read("name"),
      organisation: read("organisation"),
      type: matchAllowedValue(read("type"), TYPES),
      deadline: read("deadline"),
      status: matchAllowedValue(read("status"), STATUSES),
      link: read("link"),
      notes: read("notes"),
      // Priority is optional in a CSV: a blank cell (or no column) means Medium
      priority: matchAllowedValue(read("priority"), PRIORITIES) || DEFAULT_PRIORITY
    };

    const errors = validateForm(values);
    const problems = Object.keys(errors).map(key => errors[key]);
    if (problems.length > 0) {
      result.skipped.push({ row: rowNumber, reason: problems.join(" ") });
      return;
    }

    const key = duplicateKey(values);
    if (seenKeys.has(key)) {
      result.duplicates++;
      return;
    }
    seenKeys.add(key);
    result.added.push(createRecord(values, null));
  });

  return result;
}


/* ---------- 6. DOM references ---------- */
/* Only look up elements when running in a browser (keeps the logic above testable). */

const hasDom = typeof document !== "undefined";
const $ = hasDom ? (id) => document.getElementById(id) : () => null;

const els = {
  // dashboard
  statTotal: $("statTotal"),
  statNotApplied: $("statNotApplied"),
  statApplied: $("statApplied"),
  statShortlisted: $("statShortlisted"),
  statSelected: $("statSelected"),
  statRejected: $("statRejected"),
  dashDeadlineList: $("dashDeadlineList"),
  recentList: $("recentList"),
  // deadlines page
  overduePanel: $("overduePanel"),
  overdueList: $("overdueList"),
  overdueCount: $("overdueCount"),
  upcomingPanel: $("upcomingPanel"),
  upcomingList: $("upcomingList"),
  upcomingCount: $("upcomingCount"),
  upcomingHint: $("upcomingHint"),
  deadlinesEmpty: $("deadlinesEmpty"),
  deadlinesEmptyTitle: $("deadlinesEmptyTitle"),
  deadlinesEmptyText: $("deadlinesEmptyText"),
  // applications page
  tableBody: $("tableBody"),
  tableWrap: $("tableWrap"),
  cardList: $("cardList"),
  emptyState: $("emptyState"),
  noResults: $("noResults"),
  resultCount: $("resultCount"),
  searchInput: $("searchInput"),
  typeFilter: $("typeFilter"),
  statusFilter: $("statusFilter"),
  sortOrder: $("sortOrder"),
  importFile: $("importFile"),
  // CSV import result dialog
  importOverlay: $("importOverlay"),
  importTitle: $("importTitle"),
  importSummary: $("importSummary"),
  importIssues: $("importIssues"),
  importHelp: $("importHelp"),
  // add / edit form
  modalOverlay: $("modalOverlay"),
  modalTitle: $("modalTitle"),
  form: $("opportunityForm"),
  nameInput: $("nameInput"),
  orgInput: $("orgInput"),
  typeInput: $("typeInput"),
  deadlineInput: $("deadlineInput"),
  linkInput: $("linkInput"),
  statusInput: $("statusInput"),
  notesInput: $("notesInput"),
  // delete dialog, toasts, layout
  confirmOverlay: $("confirmOverlay"),
  confirmMessage: $("confirmMessage"),
  toastContainer: $("toastContainer"),
  sidebar: $("sidebar"),
  backdrop: $("backdrop"),
  menuBtn: $("menuBtn"),
  pageTitle: $("pageTitle"),
  // chart, board, theme
  donut: $("donut"),
  donutTotal: $("donutTotal"),
  legend: $("legend"),
  chartWrap: $("chartWrap"),
  chartEmpty: $("chartEmpty"),
  chartHint: $("chartHint"),
  boardColumns: $("boardColumns"),
  heroBody: $("heroBody"),
  reminderBody: $("reminderBody"),
  notifyStatus: $("notifyStatus"),
  notifyBtn: $("notifyBtn"),
  demoBanner: $("demoBanner"),
  dashInterviewList: $("dashInterviewList"),
  intUpcomingList: $("intUpcomingList"),
  intPastList: $("intPastList"),
  intUpcomingCount: $("intUpcomingCount"),
  intPastCount: $("intPastCount"),
  addInterviewBtn: $("addInterviewBtn"),
  analyticsBody: $("analyticsBody"),
  analyticsEmpty: $("analyticsEmpty"),
  kpiGrid: $("kpiGrid"),
  kpiNote: $("kpiNote"),
  monthChart: $("monthChart"),
  monthHint: $("monthHint"),
  typeChart: $("typeChart"),
  orgChart: $("orgChart"),
  orgHint: $("orgHint"),
  detailOverlay: $("detailOverlay"),
  detailTitle: $("detailTitle"),
  detailSub: $("detailSub"),
  detailPanel: $("detailPanel"),
  interviewOverlay: $("interviewOverlay"),
  interviewTitle: $("interviewTitle"),
  interviewForm: $("interviewForm"),
  intApp: $("intApp"),
  intMoveRow: $("intMoveRow"),
  intMoveStage: $("intMoveStage"),
  confirmTitle: $("confirmTitle"),
  confirmOkBtn: $("confirmDeleteBtn"),
  priorityFilter: $("priorityFilter"),
  priorityInput: $("priorityInput"),
  icsBtn: $("icsBtn"),
  calMonthLabel: $("calMonthLabel"),
  calGrid: $("calGrid"),
  calDayPanel: $("calDayPanel"),
  calDayTitle: $("calDayTitle"),
  calDayList: $("calDayList"),
  calAddBtn: $("calAddBtn"),
  calPrev: $("calPrev"),
  calNext: $("calNext"),
  calToday: $("calToday"),
  themeBtn: $("themeBtn"),
  themeIcon: $("themeIcon"),
  themeLabel: $("themeLabel")
};


/* ---------- 7. Rendering (draw the screen from the data) ---------- */

/**
 * Escape text before putting it into HTML so user input can never
 * be run as code (protects against XSS).
 */
function escapeHtml(text) {
  // Quotes are escaped too, because many values are placed inside HTML attributes (title="...", href="...")
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Read the current search / filter / sort controls. */
function getCurrentFilters() {
  return {
    search: els.searchInput.value,
    type: els.typeFilter.value,
    status: els.statusFilter.value,
    priority: els.priorityFilter.value,
    sort: els.sortOrder.value
  };
}

/** Redraw the whole page. Called after every data change. */
/** Banner on the Dashboard while demo examples are present. */
function renderDemoBanner() {
  const count = applications.filter(app => app.demo).length;
  els.demoBanner.hidden = count === 0;
  if (count > 0) $("demoBannerText").textContent = count + " fictional demo " + (count === 1 ? "opportunity is" : "opportunities are") + " shown so you can explore the app. They are examples, not real openings.";
}

function clearDemoData() {
  const count = applications.filter(app => app.demo).length;
  if (count === 0) return;
  askConfirm("Remove the " + count + " demo " + (count === 1 ? "opportunity" : "opportunities") + "? Opportunities you added or edited are kept.", () => {
    applications = applications.filter(app => !app.demo);
    if (detailId && !applications.some(app => app.id === detailId)) closeDetail();
    saveApplications();
    renderAll();
    showToast("Demo data cleared.");
  }, { title: "Clear demo data?", label: "Clear demo data" });
}

function renderAll() {
  renderDemoBanner();
  renderStats();
  renderHero();
  renderReminder();
  renderChart();
  renderDashboard();
  renderCalendar();
  renderBoard();
  renderDeadlinesPage();
  renderApplications();
  renderInterviewsPage();
  renderAnalytics();
  if (detailId) renderDetail();      // keep an open details dialog in step with the data
}

/** Update the six statistic cards (always calculated from saved data). */
let statsShownBefore = false;           // the first draw of the numbers should not "pop"

function renderStats() {
  const stats = calculateStats(applications);
  // A number that changed gets a short "pop" so you can see what your action did
  const setStat = (element, value) => {
    const changed = statsShownBefore && element.textContent !== String(value);
    element.textContent = value;
    if (changed) {
      element.classList.remove("bump");
      void element.offsetWidth;            // restart the CSS animation
      element.classList.add("bump");
    }
  };
  setStat(els.statTotal, stats.total);
  setStat(els.statNotApplied, stats.notApplied);
  setStat(els.statApplied, stats.inProgress);
  setStat(els.statShortlisted, stats.shortlisted);
  setStat(els.statSelected, stats.selected);
  setStat(els.statRejected, stats.rejected);
  statsShownBefore = true;
}

/* ----- Small HTML snippets reused in several places ----- */

function statusBadge(status) {
  // "Not Applied" -> class "status-not-applied"
  const cssName = status.toLowerCase().replace(/\s+/g, "-");
  return '<span class="badge status-' + cssName + '">' + escapeHtml(status) + "</span>";
}
/** Small coloured dot + word for High and Low priority. Medium (the default) shows nothing, to keep lists tidy. */
function priorityHtml(app) {
  const priority = getPriority(app);
  if (priority === DEFAULT_PRIORITY) return "";
  return ' <span class="prio prio-' + priority.toLowerCase() + '">' + priority + "</span>";
}
function typeBadge(type) {
  return '<span class="badge type-' + type.toLowerCase() + '">' + escapeHtml(type) + "</span>";
}
function linkHtml(app) {
  if (!app.link || !isValidUrl(app.link)) return '<span class="dash-muted">&mdash;</span>';
  // rel="noopener noreferrer" is a security best practice for target="_blank"
  return '<a href="' + escapeHtml(app.link) + '" target="_blank" rel="noopener noreferrer">Open</a>';
}
/** Optional notes shown as one short line under the name in the table (full text on hover). */
function notesLineHtml(app) {
  if (!app.notes) return "";
  return '<div class="cell-notes" title="' + escapeHtml(app.notes) + '">' + escapeHtml(app.notes) + "</div>";
}
function deadlineHtml(app) {
  const indicator = getDeadlineIndicator(app);
  const label = indicator
    ? '<span class="pill pill-' + indicator.urgency + '">' + indicator.text + "</span>"
    : "";
  // The date stays on one line; the label may wrap below it
  return '<span class="date-text">' + formatDate(app.deadline) + "</span>" + label;
}
/** Small "3/6 docs" chip, with a warning style when the deadline is close and documents are missing. */
function docsChipHtml(app) {
  const { done, total } = getDocumentProgress(app);
  if (total === 0) return "";
  const warn = getDocumentWarning(app) ? " chip-warn" : (done === total ? " chip-done" : "");
  return '<span class="chip' + warn + '" title="Document checklist">Docs ' + done + "/" + total + "</span>";
}
/** The opportunity name as a button that opens its details dialog. */
function nameButtonHtml(app) {
  return '<button type="button" class="name-btn" data-action="details" data-id="' + app.id + '">' + escapeHtml(app.name) + "</button>";
}
function actionButtons(app) {
  return (
    '<div class="row-actions">' +
      '<button type="button" class="btn btn-secondary btn-small" data-action="details" data-id="' + app.id + '">Details</button>' +
      '<button type="button" class="btn btn-secondary btn-small" data-action="edit" data-id="' + app.id + '">Edit</button>' +
      '<button type="button" class="btn btn-danger btn-small" data-action="delete" data-id="' + app.id + '">Delete</button>' +
    "</div>"
  );
}

/** One row for a deadline list: name, organisation, date, days remaining, status. */
function deadlineItemHtml(app, today) {
  const days = daysUntil(app.deadline, today);
  const urgency = getDeadlineUrgency(days);
  return (
    '<li class="item item-' + urgency + '">' +
      '<div class="item-main">' +
        '<div class="item-title">' + nameButtonHtml(app) + "</div>" +
        '<div class="item-meta">' + escapeHtml(app.organisation) + " &middot; " + escapeHtml(app.type) + "</div>" +
      "</div>" +
      '<div class="item-side">' +
        '<span class="item-date">' + formatDate(app.deadline) + "</span>" +
        '<span class="pill pill-' + urgency + '">' + daysLabel(days) + "</span>" +
        statusBadge(app.status) +
      "</div>" +
    "</li>"
  );
}

/** One row for the "Recently Added" list. */
function recentItemHtml(app) {
  return (
    '<li class="item">' +
      '<div class="item-main">' +
        '<div class="item-title">' + nameButtonHtml(app) + "</div>" +
        '<div class="item-meta">' + escapeHtml(app.organisation) + " &middot; " + escapeHtml(app.type) + "</div>" +
      "</div>" +
      '<div class="item-side">' +
        '<span class="item-date">' + formatDate(app.deadline) + "</span>" +
        statusBadge(app.status) +
      "</div>" +
    "</li>"
  );
}

function emptyItemHtml(message) {
  return '<li class="item-empty">' + message + "</li>";
}

/* ----- View 1: Dashboard previews ----- */

function renderDashboard() {
  const today = getToday();

  // Deadline preview: overdue items first, then the nearest upcoming ones
  const preview = getOverdueDeadlines(applications, today)
    .concat(getUpcomingDeadlines(applications, today))
    .slice(0, PREVIEW_COUNT);

  if (preview.length === 0) {
    els.dashDeadlineList.innerHTML = emptyItemHtml(
      applications.length === 0
        ? "No deadlines yet. Add your first opportunity to see it here."
        : "Nothing to track right now. Everything is Selected or Rejected."
    );
  } else {
    els.dashDeadlineList.innerHTML = preview.map(app => deadlineItemHtml(app, today)).join("");
  }

  // Recently added applications
  const recent = getRecentApplications(applications, RECENT_COUNT);
  els.recentList.innerHTML = recent.length === 0
    ? emptyItemHtml("No applications yet. Click Add Opportunity to start.")
    : recent.map(recentItemHtml).join("");

  // Next interviews
  const upcomingInterviews = splitInterviews(applications, getTodayIso()).upcoming.slice(0, PREVIEW_COUNT);
  els.dashInterviewList.innerHTML = upcomingInterviews.length === 0
    ? emptyItemHtml(applications.length === 0
        ? "No interviews yet."
        : "No upcoming interviews. Add one from an opportunity's Details or the Interviews page.")
    : upcomingInterviews.map(x => interviewItemHtml(x, getTodayIso(), "dashboard")).join("");
}

/* ----- View 3: Upcoming Deadlines page ----- */

function renderDeadlinesPage() {
  const today = getToday();
  const overdue = getOverdueDeadlines(applications, today);
  const upcoming = getUpcomingDeadlines(applications, today);
  const nothingToShow = overdue.length === 0 && upcoming.length === 0;

  els.deadlinesEmpty.hidden = !nothingToShow;
  els.overduePanel.hidden = overdue.length === 0;
  els.upcomingPanel.hidden = nothingToShow;

  if (nothingToShow) {
    if (applications.length === 0) {
      els.deadlinesEmptyTitle.textContent = "No deadlines yet";
      els.deadlinesEmptyText.textContent = "Add an opportunity to start tracking its deadline.";
    } else {
      els.deadlinesEmptyTitle.textContent = "Nothing left to track";
      els.deadlinesEmptyText.textContent = "All your opportunities are Selected or Rejected.";
    }
    return;
  }

  els.overdueCount.textContent = overdue.length;
  els.overdueList.innerHTML = overdue.map(app => deadlineItemHtml(app, today)).join("");

  els.upcomingCount.textContent = upcoming.length;
  const dueThisWeek = countDueWithin(applications, SOON_DAYS, today);
  els.upcomingHint.textContent = dueThisWeek > 0
    ? dueThisWeek + " due within " + SOON_DAYS + " days"
    : "Deadline is today or later";
  els.upcomingList.innerHTML = upcoming.length === 0
    ? emptyItemHtml("No upcoming deadlines.")
    : upcoming.map(app => deadlineItemHtml(app, today)).join("");
}

/* ----- View 2: Applications table (desktop) and cards (mobile / tablet) ----- */

function renderApplications() {
  const visible = getVisibleApplications(applications, getCurrentFilters());
  const noData = applications.length === 0;
  const noMatches = !noData && visible.length === 0;

  // Show the right empty state, or the real list
  els.emptyState.hidden = !noData;
  els.noResults.hidden = !noMatches;
  els.tableWrap.hidden = visible.length === 0;
  els.cardList.hidden = visible.length === 0;

  els.resultCount.textContent = noData
    ? ""
    : "Showing " + visible.length + " of " + applications.length;

  els.tableBody.innerHTML = visible.map(app =>
    "<tr>" +
      '<td class="cell-title">' + nameButtonHtml(app) + priorityHtml(app) + '<div class="cell-chips">' + docsChipHtml(app) + "</div>" + notesLineHtml(app) + "</td>" +
      "<td>" + escapeHtml(app.organisation) + "</td>" +
      "<td>" + typeBadge(app.type) + "</td>" +
      "<td>" + deadlineHtml(app) + "</td>" +
      "<td>" + statusBadge(app.status) + "</td>" +
      "<td>" + linkHtml(app) + "</td>" +
      "<td>" + actionButtons(app) + "</td>" +
    "</tr>"
  ).join("");

  els.cardList.innerHTML = visible.map(app =>
    '<article class="app-card">' +
      "<h3>" + nameButtonHtml(app) + priorityHtml(app) + "</h3>" +
      '<div class="app-card-org">' + escapeHtml(app.organisation) + "</div>" +
      '<div class="app-card-row">' + typeBadge(app.type) + statusBadge(app.status) + docsChipHtml(app) + "</div>" +
      '<div class="app-card-row">Deadline: ' + deadlineHtml(app) + "</div>" +
      '<div class="app-card-row">Link: ' + linkHtml(app) + "</div>" +
      (app.notes ? '<div class="card-notes">Notes: ' + escapeHtml(app.notes) + "</div>" : "") +
      actionButtons(app) +
    "</article>"
  ).join("");
}


/* ---------- 7b. Status chart (donut drawn with plain SVG) ---------- */

function renderChart() {
  const segments = getStatusSegments(applications);
  const total = applications.length;

  els.donutTotal.textContent = total;
  els.chartWrap.hidden = total === 0;
  els.chartEmpty.hidden = total !== 0;
  els.chartHint.textContent = total === 0 ? "" : "Share of all opportunities by status";

  // Donut: one circle per status. stroke-dasharray draws a slice of the circle.
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  let svg = '<circle class="donut-track" cx="60" cy="60" r="' + radius + '"></circle>';
  let used = 0;                       // how much of the circle is already drawn
  segments.forEach(seg => {
    if (seg.count === 0) return;
    const length = (seg.count / total) * circumference;
    svg +=
      '<circle cx="60" cy="60" r="' + radius + '" stroke="' + STATUS_COLORS[seg.status] + '"' +
      ' stroke-dasharray="' + length.toFixed(2) + " " + (circumference - length).toFixed(2) + '"' +
      ' stroke-dashoffset="' + (-used).toFixed(2) + '"></circle>';
    used += length;
  });
  els.donut.innerHTML = svg;

  // Legend with counts, so the chart can also be read without colours
  els.legend.innerHTML = segments.map(seg =>
    '<li><span class="legend-dot" style="background:' + STATUS_COLORS[seg.status] + '"></span>' +
    escapeHtml(seg.status) + " " +
    '<span class="legend-count">' + seg.count + "</span> " +
    '<span class="legend-pct">' + seg.percent + "%</span></li>"
  ).join("");
}


/* ---------- 7a. Hero: live countdown to the next deadline ---------- */

const RING_RADIUS = 52;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const RING_WINDOW_DAYS = 30;           // the ring is "full" when the deadline is 30 or more days away

const pad2 = (n) => String(n).padStart(2, "0");

function renderHero() {
  const next = getNextDeadline(applications);
  heroTarget = next ? next.deadline : null;

  // Nothing to count down to: a short, useful message instead
  if (!next) {
    const overdue = getOverdueDeadlines(applications).length;
    let title = "Nothing on the clock yet";
    let text = "Add an opportunity and a live countdown to its deadline starts here.";
    let button = '<button type="button" class="btn btn-primary" data-add>Add opportunity</button>';
    if (applications.length > 0 && overdue > 0) {
      title = overdue + (overdue === 1 ? " deadline has passed" : " deadlines have passed");
      text = "Nothing is coming up. Open the list to update or close these out.";
      button = '<button type="button" class="btn btn-primary" data-goto="deadlines">View deadlines</button>';
    } else if (applications.length > 0) {
      title = "All caught up";
      text = "Every opportunity is either Selected or Rejected. Add a new one when you find it.";
    }
    els.heroBody.innerHTML =
      '<div class="hero-text"><p class="hero-kicker">Next deadline</p>' +
      '<h2 class="hero-title">' + title + "</h2>" +
      '<p class="hero-sub">' + text + "</p>" +
      '<div class="hero-actions">' + button + "</div></div>";
    return;
  }

  const parts = getCountdownParts(next.deadline, Date.now());
  const urgency = getDeadlineUrgency(daysUntil(next.deadline, getToday()));
  const link = next.link && isValidUrl(next.link)
    ? '<a class="btn btn-secondary" href="' + escapeHtml(next.link) + '" target="_blank" rel="noopener noreferrer">Open application page</a>'
    : "";

  els.heroBody.innerHTML =
    '<div class="hero-text">' +
      '<p class="hero-kicker">Next deadline</p>' +
      '<h2 class="hero-title">' + escapeHtml(next.name) + "</h2>" +
      '<p class="hero-sub">' + escapeHtml(next.organisation) + ", " + escapeHtml(next.type) + " " + statusBadge(next.status) + priorityHtml(next) + "</p>" +
      '<div class="countdown" role="timer" aria-label="Time left until the end of the deadline day">' +
        '<div class="cd"><span class="cd-num" id="cdHours">' + pad2(parts.hours) + '</span><span class="cd-label">hours</span></div>' +
        '<span class="cd-sep" aria-hidden="true">:</span>' +
        '<div class="cd"><span class="cd-num" id="cdMinutes">' + pad2(parts.minutes) + '</span><span class="cd-label">minutes</span></div>' +
        '<span class="cd-sep" aria-hidden="true">:</span>' +
        '<div class="cd"><span class="cd-num" id="cdSeconds">' + pad2(parts.seconds) + '</span><span class="cd-label">seconds</span></div>' +
      "</div>" +
      '<p class="hero-note">Closes at the end of ' + formatDate(next.deadline) + "</p>" +
      '<div class="hero-actions">' +
        '<button type="button" class="btn btn-primary" data-action="details" data-id="' + next.id + '">Update stage</button>' + link +
      "</div>" +
    "</div>" +
    '<div class="hero-ring ring-' + urgency + '" aria-hidden="true">' +
      '<svg viewBox="0 0 120 120"><circle class="ring-track" cx="60" cy="60" r="' + RING_RADIUS + '"></circle>' +
      '<circle class="ring-arc" id="ringArc" cx="60" cy="60" r="' + RING_RADIUS + '" stroke-dasharray="' + RING_LENGTH.toFixed(2) + '"></circle></svg>' +
      '<div class="ring-center"><span class="ring-days" id="cdDays">' + parts.days + '</span><span class="ring-caption" id="cdDaysLabel"></span></div>' +
    "</div>";
  tickHero();
}

/** Runs every second: updates the digits and the ring without redrawing the page. */
function tickHero() {
  if (!heroTarget) return;
  const parts = getCountdownParts(heroTarget, Date.now());
  if (parts.totalMs <= 0) { renderAll(); return; }       // the deadline day just ended

  const set = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
  set("cdHours", pad2(parts.hours));
  set("cdMinutes", pad2(parts.minutes));
  set("cdSeconds", pad2(parts.seconds));
  set("cdDays", String(parts.days));
  set("cdDaysLabel", parts.days === 1 ? "day left" : "days left");

  const arc = $("ringArc");
  if (arc) {
    const fraction = Math.min(1, parts.totalMs / (RING_WINDOW_DAYS * 86400000));
    arc.setAttribute("stroke-dashoffset", (RING_LENGTH * (1 - fraction)).toFixed(2));
  }
}

/** A short burst of confetti, used when something becomes "Selected". Skipped if the user prefers less motion. */
function celebrate() {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.createElement("div");
  layer.className = "confetti";
  layer.setAttribute("aria-hidden", "true");
  const colors = ["#2dd4bf", "#ff8a5b", "#ffd166", "#a78bfa", "#60a5fa", "#f472b6"];
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement("span");
    piece.style.setProperty("--x", (Math.random() * 100).toFixed(1) + "vw");
    piece.style.setProperty("--drift", ((Math.random() - 0.5) * 220).toFixed(0) + "px");
    piece.style.setProperty("--spin", Math.floor(Math.random() * 720 - 360) + "deg");
    piece.style.setProperty("--delay", (Math.random() * 0.35).toFixed(2) + "s");
    piece.style.background = colors[i % colors.length];
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2600);
}


/* ---------- 7b2. Reminders (Dashboard) and browser notifications ---------- */

const REMINDER_GROUPS = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Due today" },
  { key: "tomorrow", title: "Due tomorrow (1 day)" },
  { key: "within3", title: "Due in 2–3 days" },
  { key: "within7", title: "Due in 4–7 days" }
];
const REMINDER_GROUP_LIMIT = 4;     // items shown per group on the dashboard; the rest are on the deadlines page

function renderReminder() {
  const today = getToday();
  const buckets = getReminderBuckets(applications, today);
  let html = "";

  REMINDER_GROUPS.forEach(group => {
    const items = buckets[group.key];
    if (items.length === 0) return;
    html +=
      '<div class="rem-group"><h3 class="rem-title rem-' + group.key + '">' + group.title +
      ' <span class="count-pill' + (group.key === "overdue" ? " count-overdue" : "") + '">' + items.length + "</span></h3>" +
      '<ul class="item-list">' + items.slice(0, REMINDER_GROUP_LIMIT).map(app => deadlineItemHtml(app, today)).join("") + "</ul>" +
      (items.length > REMINDER_GROUP_LIMIT
        ? '<button type="button" class="link-btn" data-goto="deadlines">+' + (items.length - REMINDER_GROUP_LIMIT) + " more on the Upcoming Deadlines page</button>"
        : "") +
      "</div>";
  });

  // Documents still missing for applications that are due soon
  const warnings = applications
    .map(app => ({ app, warning: getDocumentWarning(app, today) }))
    .filter(item => item.warning)
    .sort((a, b) => a.warning.days - b.warning.days);
  if (warnings.length > 0) {
    html +=
      '<div class="rem-group"><h3 class="rem-title rem-docs">Documents to finish <span class="count-pill">' + warnings.length + "</span></h3>" +
      '<ul class="item-list">' + warnings.map(({ app, warning }) =>
        '<li class="item item-soon"><div class="item-main"><div class="item-title">' + nameButtonHtml(app) + "</div>" +
        '<div class="item-meta">' + escapeHtml(warning.text) + "</div></div>" +
        '<div class="item-side"><button type="button" class="btn btn-secondary btn-small" data-action="details" data-tab="documents" data-id="' + app.id + '">Open checklist</button></div></li>'
      ).join("") + "</ul></div>";
  }

  if (html === "") {
    html = '<p class="rem-empty">' + (applications.length === 0
      ? "No reminders yet. Add an opportunity with a deadline and its reminders appear here."
      : "Nothing is overdue and nothing is due in the next 7 days.") + "</p>";
  }
  els.reminderBody.innerHTML = html;
  renderNotifyControls();
}

/* ----- Browser notifications (opt-in, only after the user clicks the button) ----- */

let notifyPrefs = { enabled: false, sent: {} };   // sent: { "id|deadline|step": "YYYY-MM-DD" }
let notifyFailureShown = false;

function loadNotifyPrefs() {
  const fresh = { enabled: false, sent: {} };
  try {
    const raw = localStorage.getItem(NOTIFY_KEY);
    if (!raw) return fresh;
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return fresh;
    const sent = {};
    if (data.sent && typeof data.sent === "object" && !Array.isArray(data.sent)) {
      Object.keys(data.sent).forEach(key => {
        if (/^[A-Za-z0-9_-]{1,64}\|\d{4}-\d{2}-\d{2}\|[a-z0-9-]{1,10}$/.test(key)) sent[key] = String(data.sent[key]).slice(0, 10);
      });
    }
    return { enabled: data.enabled === true, sent };
  } catch (error) {
    return fresh;
  }
}

function saveNotifyPrefs() {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(notifyPrefs)); } catch (error) { /* storage blocked */ }
}

function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

/** unsupported | denied | default (not asked yet) | on | off */
function getNotifyState() {
  if (!notificationsSupported()) return "unsupported";
  const permission = Notification.permission;
  if (permission === "denied") return "denied";
  if (permission === "granted") return notifyPrefs.enabled ? "on" : "off";
  return "default";
}

function renderNotifyControls() {
  const state = getNotifyState();
  const text = {
    unsupported: "This browser does not support notifications. Reminders are shown here only.",
    denied: "Notifications are blocked for this site. Allow them in your browser's site settings to turn them on.",
    default: "Browser notifications are off.",
    on: "Browser notifications are on (they work while this page is open).",
    off: "Browser notifications are off."
  };
  const button = { default: "Enable notifications", on: "Turn off", off: "Turn on" };
  els.notifyStatus.textContent = text[state];
  els.notifyBtn.hidden = !button[state];
  if (button[state]) els.notifyBtn.textContent = button[state];
}

/** Ask the browser for permission (callback and promise styles both exist). Always resolves. */
function requestNotifyPermission() {
  return new Promise(resolve => {
    try {
      const result = Notification.requestPermission(resolve);
      if (result && typeof result.then === "function") result.then(resolve, () => resolve("default"));
    } catch (error) {
      resolve("default");
    }
  });
}

function handleNotifyClick() {
  const state = getNotifyState();
  if (state === "on") {
    notifyPrefs.enabled = false;
    saveNotifyPrefs();
    showToast("Browser notifications turned off.");
    renderNotifyControls();
  } else if (state === "off") {
    notifyPrefs.enabled = true;
    saveNotifyPrefs();
    renderNotifyControls();
    showToast("Browser notifications turned on.");
    checkNotifications();
  } else if (state === "default") {
    requestNotifyPermission().then(permission => {
      if (permission === "granted") {
        notifyPrefs.enabled = true;
        saveNotifyPrefs();
        showToast("Browser notifications turned on. You get one reminder per deadline at 7, 3 and 1 days, on the day, and when it is overdue.");
        checkNotifications();
      } else if (permission === "denied") {
        showToast("Permission was denied, so notifications stay off. You can allow them in your browser's site settings.", "error");
      } else {
        showToast("No permission was given, so notifications stay off.");
      }
      renderNotifyControls();
    });
  }
}

/** Send any reminder that is due and was not sent before. Safe to call often. */
function checkNotifications() {
  if (getNotifyState() !== "on") return;
  const due = getNotificationsDue(applications.filter(app => !app.demo), getToday(), notifyPrefs.sent);   // demo examples never notify
  if (due.length === 0) return;

  const show = (title, body, tag) => {
    try {
      new Notification(title, { body, tag });
      return true;
    } catch (error) {
      console.warn("Could not show a notification:", error);
      if (!notifyFailureShown) {
        notifyFailureShown = true;
        showToast("This browser would not show the notification. Reminders are still listed on the Dashboard.", "error");
      }
      return false;
    }
  };

  let sentOk = [];
  if (due.length <= 3) {
    due.forEach(item => {
      const ok = show(item.app.name + ": " + daysLabel(item.days),
        item.app.organisation + " · deadline " + formatDate(item.app.deadline), item.key);
      if (ok) sentOk.push(item);
    });
  } else if (show(due.length + " deadlines need attention",
      due.slice(0, 5).map(item => item.app.name).join(", ") + (due.length > 5 ? " and more" : ""), "summary")) {
    sentOk = due;
  }
  if (sentOk.length === 0) return;

  const todayIso = getTodayIso();
  sentOk.forEach(item => { notifyPrefs.sent[item.key] = todayIso; });
  // Forget reminders for opportunities that were deleted or whose deadline changed
  const live = new Set(applications.map(app => app.id + "|" + app.deadline));
  Object.keys(notifyPrefs.sent).forEach(key => {
    if (!live.has(key.split("|").slice(0, 2).join("|"))) delete notifyPrefs.sent[key];
  });
  saveNotifyPrefs();
}

/* ---------- 7b3. Calendar page ---------- */

function renderCalendar() {
  const cells = buildCalendarMonth(calYear, calMonth, applications, getTodayIso());
  els.calMonthLabel.textContent = MONTH_NAMES[calMonth] + " " + calYear;

  els.calGrid.innerHTML = cells.map(cell => {
    const total = cell.items.length;
    // Up to two names are shown inside the day (desktop); phones show a count instead
    const chips = cell.items.slice(0, 2).map(app =>
      '<span class="cal-chip status-' + app.status.toLowerCase().replace(/\s+/g, "-") + '">' + escapeHtml(app.name) + "</span>"
    ).join("");
    const more = total > 2 ? '<span class="cal-more">+' + (total - 2) + " more</span>" : "";
    const label = formatDate(cell.iso) + ", " + (total === 0 ? "no deadlines" : total + (total === 1 ? " deadline" : " deadlines"));

    return (
      '<button type="button" class="cal-cell' +
        (cell.inMonth ? "" : " cal-other") +
        (cell.isToday ? " cal-today" : "") +
        (cell.iso === calSelected ? " cal-selected" : "") +
        '" data-date="' + cell.iso + '" aria-label="' + label + '">' +
        '<span class="cal-day">' + cell.day + "</span>" +
        '<span class="cal-chips">' + chips + more + "</span>" +
        (total > 0 ? '<span class="cal-count">' + total + "</span>" : "") +
      "</button>"
    );
  }).join("");

  renderCalendarDay();
}

/** The list under the calendar showing what is due on the selected day. */
function renderCalendarDay() {
  els.calDayPanel.hidden = calSelected === null;
  if (calSelected === null) return;

  const items = applications.filter(app => app.deadline === calSelected);
  els.calDayTitle.textContent = "Due on " + formatDate(calSelected);
  els.calDayList.innerHTML = items.length === 0
    ? emptyItemHtml("Nothing is due on this day.")
    : items.map(app =>
        '<li class="item">' +
          '<div class="item-main">' +
            '<div class="item-title">' + escapeHtml(app.name) + priorityHtml(app) + "</div>" +
            '<div class="item-meta">' + escapeHtml(app.organisation) + " &middot; " + escapeHtml(app.type) + "</div>" +
          "</div>" +
          '<div class="item-side">' + statusBadge(app.status) +
            '<button type="button" class="btn btn-secondary btn-small" data-action="details" data-id="' + app.id + '">Details</button>' +
            '<button type="button" class="btn btn-secondary btn-small" data-action="edit" data-id="' + app.id + '">Edit</button>' +
          "</div>" +
        "</li>"
      ).join("");
}

function showCalendarMonth(year, month) {
  const first = new Date(year, month, 1);          // JavaScript wraps month -1 / 12 into the next or previous year
  calYear = first.getFullYear();
  calMonth = first.getMonth();
  renderCalendar();
}

function setupCalendarEvents() {
  els.calPrev.addEventListener("click", () => showCalendarMonth(calYear, calMonth - 1));
  els.calNext.addEventListener("click", () => showCalendarMonth(calYear, calMonth + 1));
  els.calToday.addEventListener("click", () => {
    const today = getToday();
    calSelected = getTodayIso();
    showCalendarMonth(today.getFullYear(), today.getMonth());
  });
  els.calGrid.addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-cell");
    if (!cell) return;
    calSelected = cell.dataset.date;
    if (cell.classList.contains("cal-other")) {
      // A grey day from the next/previous month: jump to that month
      const date = parseDate(calSelected);
      showCalendarMonth(date.getFullYear(), date.getMonth());
    } else {
      renderCalendar();
    }
  });
  els.calAddBtn.addEventListener("click", () => {
    openModal();
    if (calSelected) els.deadlineInput.value = calSelected;    // pre-fill the chosen day
  });
}


/* ---------- 7c. Board (Kanban): one column per status ---------- */

/** One draggable card. The "Move to" menu does the same job as dragging (works on phones). */
function boardCardHtml(app) {
  const options = STATUSES.map(status =>
    '<option value="' + status + '"' + (status === app.status ? " selected" : "") + ">" + status + "</option>"
  ).join("");
  return (
    '<div class="board-card" draggable="true" data-id="' + app.id + '">' +
      '<div class="board-card-title">' + nameButtonHtml(app) + priorityHtml(app) + "</div>" +
      '<div class="board-card-org">' + escapeHtml(app.organisation) + "</div>" +
      '<div class="board-card-line">' + typeBadge(app.type) + docsChipHtml(app) + deadlineHtml(app) + "</div>" +
      '<div class="board-card-actions">' +
        '<select class="input" data-move="' + app.id + '" aria-label="Move ' + escapeHtml(app.name) + ' to another status">' + options + "</select>" +
        '<button type="button" class="btn btn-secondary btn-small" data-action="details" data-id="' + app.id + '">Details</button>' +
        '<button type="button" class="btn btn-secondary btn-small" data-action="edit" data-id="' + app.id + '">Edit</button>' +
      "</div>" +
    "</div>"
  );
}

function renderBoard() {
  els.boardColumns.innerHTML = STATUSES.map(status => {
    const cards = applications
      .filter(app => app.status === status)
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    return (
      '<section class="board-col" data-status="' + status + '" aria-label="' + status + '">' +
        '<div class="board-col-head"><h2>' + status + '</h2><span class="board-count">' + cards.length + "</span></div>" +
        '<div class="board-cards">' +
          (cards.length === 0 ? '<div class="board-empty">Drop a card here</div>' : cards.map(boardCardHtml).join("")) +
        "</div>" +
      "</section>"
    );
  }).join("");
}

/** Change one opportunity's stage (used by dragging and by the Move to menu). The move is added to its history, dated today. */
function moveToStatus(id, status) {
  const app = applications.find(item => item.id === id);
  if (!app || !STATUSES.includes(status) || app.status === status) return;
  const result = applyStageChange(app, status, getTodayIso(), "", getTodayIso());
  if (!result.ok) { showToast(result.error, "error"); renderBoard(); return; }
  saveApplications();
  renderAll();
  showToast('Moved "' + app.name + '" to ' + status + ".");
  if (status === "Selected") celebrate();
}

/* Drag and drop (HTML5 API). Listeners sit on the board because cards are re-drawn often. */
function setupBoardEvents() {
  const board = els.boardColumns;
  let draggedId = null;

  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".board-card");
    if (!card) return;
    draggedId = card.dataset.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedId);   // Firefox needs some data to start a drag
    card.classList.add("dragging");
  });
  board.addEventListener("dragend", () => {
    draggedId = null;
    board.querySelectorAll(".dragging, .drag-over").forEach(el => el.classList.remove("dragging", "drag-over"));
  });
  board.addEventListener("dragover", (e) => {
    const column = e.target.closest(".board-col");
    if (!column || !draggedId) return;
    e.preventDefault();                                // allows dropping here
    column.classList.add("drag-over");
  });
  board.addEventListener("dragleave", (e) => {
    const column = e.target.closest(".board-col");
    if (column && !column.contains(e.relatedTarget)) column.classList.remove("drag-over");
  });
  board.addEventListener("drop", (e) => {
    const column = e.target.closest(".board-col");
    if (!column || !draggedId) return;
    e.preventDefault();
    const id = draggedId;
    draggedId = null;
    moveToStatus(id, column.dataset.status);
    renderBoard();                                     // clears highlight even when nothing moved
  });

  // "Move to" menu and Edit button on each card
  board.addEventListener("change", (e) => {
    const select = e.target.closest("select[data-move]");
    if (select) moveToStatus(select.dataset.move, select.value);
  });
}


/* ---------- 7d. Light / dark theme ---------- */

const MOON_PATH = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
const SUN_PATH =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';

/** Show the right label and icon on the toggle button for the current theme. */
function updateThemeButton() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  els.themeLabel.textContent = isDark ? "Light mode" : "Dark mode";
  els.themeBtn.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
  els.themeIcon.innerHTML = isDark ? SUN_PATH : MOON_PATH;
}

function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* storage blocked: theme just won't be remembered */ }
  updateThemeButton();
}


/* ---------- 7f. Interviews: lists and the Interviews page ---------- */

function interviewLocationHtml(text) {
  if (!text) return "";
  // Only real http(s) links become clickable; anything else is shown as plain text
  if (isValidUrl(text)) return '<a href="' + escapeHtml(text) + '" target="_blank" rel="noopener noreferrer">Open meeting link</a>';
  return escapeHtml(text);
}

function interviewNotesHtml(iv) {
  const rows = [["Preparation", iv.prep], ["Questions asked", iv.questions], ["Feedback", iv.feedback]]
    .filter(row => row[1])
    .map(row => "<dt>" + row[0] + "</dt><dd>" + escapeHtml(row[1]) + "</dd>");
  return rows.length ? '<dl class="iv-notes">' + rows.join("") + "</dl>" : "";
}

/**
 * One interview as a list row.
 * mode: "dashboard" (compact), "page" (with opportunity name and actions) or "detail" (inside one opportunity).
 */
function interviewItemHtml(entry, todayIso, mode) {
  const { app, interview: iv } = entry;
  const days = daysUntil(iv.date, parseDate(todayIso));
  const upcoming = iv.date >= todayIso && iv.outcome === "Pending";

  let rowClass = "item-past", pill = "";
  if (upcoming) {
    rowClass = days === 0 ? "item-urgent" : "item-ok";
    pill = '<span class="pill pill-' + (days === 0 ? "urgent" : "ok") + '">' +
      (days === 0 ? "Today" : days === 1 ? "Tomorrow" : "In " + days + " days") + "</span>";
  } else if (iv.outcome === "Pending") {
    rowClass = "item-needs";
    pill = '<span class="pill pill-soon">Needs outcome</span>';
  }

  const title = mode === "detail"
    ? escapeHtml(iv.round)
    : nameButtonHtml(app) + ' <span class="dash-muted">· ' + escapeHtml(iv.round) + "</span>";
  const where = interviewLocationHtml(iv.location);
  const meta =
    (mode === "detail" ? "" : escapeHtml(app.organisation) + " &middot; ") +
    '<span class="badge itype">' + escapeHtml(iv.type) + "</span> " +
    formatDate(iv.date) + (iv.time ? " at " + escapeHtml(iv.time) : "") +
    (where ? " &middot; " + where : "");
  const actions = mode === "dashboard" ? "" :
    '<button type="button" class="btn btn-secondary btn-small" data-action="edit-interview" data-id="' + app.id + '" data-iid="' + iv.id + '">Edit</button>' +
    '<button type="button" class="btn btn-danger btn-small" data-action="delete-interview" data-id="' + app.id + '" data-iid="' + iv.id + '">Delete</button>';

  return (
    '<li class="item ' + rowClass + '">' +
      '<div class="item-main">' +
        '<div class="item-title">' + title + "</div>" +
        '<div class="item-meta">' + meta + "</div>" +
        (mode === "dashboard" ? "" : interviewNotesHtml(iv)) +
      "</div>" +
      '<div class="item-side">' + pill + '<span class="badge outcome-' + iv.outcome.toLowerCase() + '">' + iv.outcome + "</span>" + actions + "</div>" +
    "</li>"
  );
}

function renderInterviewsPage() {
  const todayIso = getTodayIso();
  const { upcoming, past } = splitInterviews(applications, todayIso);
  els.intUpcomingCount.textContent = upcoming.length;
  els.intPastCount.textContent = past.length;
  els.addInterviewBtn.disabled = applications.length === 0;
  els.addInterviewBtn.title = applications.length === 0 ? "Add an opportunity first" : "";

  els.intUpcomingList.innerHTML = upcoming.length === 0
    ? emptyItemHtml(applications.length === 0
        ? "Add an opportunity first, then schedule its interview rounds here."
        : "No upcoming interviews. Use Add interview to schedule a round.")
    : upcoming.map(entry => interviewItemHtml(entry, todayIso, "page")).join("");
  els.intPastList.innerHTML = past.length === 0
    ? emptyItemHtml("Finished interviews appear here so you can record outcomes, questions and feedback.")
    : past.map(entry => interviewItemHtml(entry, todayIso, "page")).join("");
}


/* ---------- 7g. Analytics page ---------- */

function barListHtml(rows, valueText) {
  const max = Math.max(...rows.map(row => row.count), 0);
  return '<ul class="bars">' + rows.map(row =>
    '<li><span class="bar-label" title="' + escapeHtml(row.label) + '">' + escapeHtml(row.label) + "</span>" +
    '<span class="bar-track"><span class="bar-fill" style="width:' + (max === 0 ? 0 : (row.count / max) * 100).toFixed(1) + '%"></span></span>' +
    '<span class="bar-value">' + valueText(row) + "</span></li>"
  ).join("") + "</ul>";
}

function renderAnalytics() {
  const stats = getAnalytics(applications, getToday());
  els.analyticsEmpty.hidden = stats.total !== 0;
  els.analyticsBody.hidden = stats.total === 0;
  if (stats.total === 0) return;

  const kpi = (label, value, sub) =>
    '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-value">' + value + "</span>" +
    (sub ? '<span class="kpi-sub">' + sub + "</span>" : "") + "</div>";
  const of = (n) => stats.submitted === 0 ? "No submitted applications yet" : n + " of " + stats.submitted + " submitted";
  els.kpiGrid.innerHTML =
    kpi("Total tracked", stats.total, "") +
    kpi("Submitted", stats.submitted, "Left Not Applied") +
    kpi("Shortlisted", stats.shortlisted, "") +
    kpi("Selected", stats.selected, "") +
    kpi("Rejected", stats.rejected, "") +
    kpi("Shortlisting rate", stats.shortlistingRate, of(stats.shortlisted)) +
    kpi("Selection rate", stats.selectionRate, of(stats.selected));
  els.kpiNote.textContent =
    "Submitted means an opportunity that has moved past Not Applied. Shortlisting rate = shortlisted divided by submitted. " +
    "Selection rate = selected divided by submitted. Shortlisted includes anything that has ever reached that stage, even if it was later Selected or Rejected.";

  // Monthly activity: columns for the last 6 months
  const tallest = Math.max(...stats.months.map(m => m.count), 0);
  els.monthChart.innerHTML = '<ul class="vbars">' + stats.months.map(month =>
    '<li><span class="vbar-value">' + month.count + "</span>" +
    '<span class="vbar-track"><span class="vbar-fill" style="height:' + (tallest === 0 ? 0 : (month.count / tallest) * 100).toFixed(1) + '%"></span></span>' +
    '<span class="vbar-label">' + month.label + "</span></li>"
  ).join("") + "</ul>";
  const notes = ["Applications submitted per month, last 6 months."];
  if (stats.undated > 0) notes.push(stats.undated + (stats.undated === 1 ? " submitted application has" : " submitted applications have") + " no recorded date and " + (stats.undated === 1 ? "is" : "are") + " not shown.");
  if (stats.earlier > 0) notes.push(stats.earlier + " earlier than 6 months ago.");
  els.monthHint.textContent = notes.join(" ");

  els.typeChart.innerHTML = barListHtml(stats.byType, row => row.count + " (" + row.percent.toFixed(1) + "%)");
  els.orgChart.innerHTML = barListHtml(stats.byOrganisation, row => String(row.count));
  els.orgHint.textContent = stats.moreOrganisations > 0
    ? "Top " + stats.byOrganisation.length + ", plus " + stats.moreOrganisations + " more"
    : "All tracked opportunities";
}


/* ---------- 7h. Details dialog: Progress | Documents | Interviews ---------- */

const DETAIL_TABS = ["progress", "documents", "interviews"];

function openDetail(id, tab) {
  if (!applications.some(app => app.id === id)) return;
  returnFocusTo = document.activeElement;
  detailId = id;
  detailTab = DETAIL_TABS.includes(tab) ? tab : "progress";
  editingDocId = null;
  els.detailOverlay.hidden = false;
  renderDetail();
  $("detailCloseBtn").focus();
}

function closeDetail() {
  els.detailOverlay.hidden = true;
  detailId = null;
  editingDocId = null;
  if (returnFocusTo && document.body.contains(returnFocusTo)) returnFocusTo.focus();
  returnFocusTo = null;
}

function renderDetail() {
  const app = applications.find(item => item.id === detailId);
  if (!app) { closeDetail(); return; }

  // Keep keyboard focus on the same control after the panel is redrawn
  const active = document.activeElement;
  const focusKey = active && els.detailPanel.contains(active) ? active.dataset.key : null;

  els.detailTitle.textContent = app.name;
  els.detailSub.innerHTML = escapeHtml(app.organisation) + " &middot; " + escapeHtml(app.type) + " " + statusBadge(app.status) +
    " &middot; Deadline " + formatDate(app.deadline);

  DETAIL_TABS.forEach(tab => {
    const button = $("tab" + tab.charAt(0).toUpperCase() + tab.slice(1));
    const selected = tab === detailTab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  els.detailPanel.setAttribute("aria-labelledby", "tab" + detailTab.charAt(0).toUpperCase() + detailTab.slice(1));

  els.detailPanel.innerHTML =
    detailTab === "progress" ? progressTabHtml(app) :
    detailTab === "documents" ? documentsTabHtml(app) : interviewsTabHtml(app);

  if (focusKey) {
    const again = els.detailPanel.querySelector('[data-key="' + focusKey + '"]');
    if (again) again.focus();
  }
}

/* ----- Progress tab ----- */

/** The stage suggested in the "Move to" menu: the next step on the path, else the first other stage. */
function suggestNextStage(app) {
  const index = STAGE_PATH.indexOf(app.status);
  if (index >= 0 && index < STAGE_PATH.length - 1) return STAGE_PATH[index + 1];
  return STATUSES.find(status => status !== app.status);
}

function progressTabHtml(app) {
  const stateText = { done: "completed", current: "current stage", skipped: "skipped", todo: "not reached" };
  const stepper = '<ol class="stepper" aria-label="Application stages">' + getStepperSteps(app).map(step =>
    '<li class="step step-' + step.state + (step.status === "Rejected" ? " step-rejected" : "") + '"' + (step.state === "current" ? ' aria-current="step"' : "") + ">" +
    '<span class="step-dot" aria-hidden="true"></span><span class="step-label">' + escapeHtml(step.status) +
    '</span><span class="sr-only"> (' + stateText[step.state] + ")</span></li>"
  ).join("") + "</ol>";

  const suggested = suggestNextStage(app);
  const options = STATUSES.filter(status => status !== app.status).map(status =>
    '<option value="' + status + '"' + (status === suggested ? " selected" : "") + ">" + status + "</option>"
  ).join("");
  const form =
    '<form class="stage-form" id="stageForm" novalidate>' +
      '<div class="form-group"><label for="stageSelect">Move to</label><select id="stageSelect" class="input" data-key="stageSelect">' + options + "</select></div>" +
      '<div class="form-group"><label for="stageDate">Date of change</label><input type="date" id="stageDate" class="input" value="' + getTodayIso() + '" max="' + getTodayIso() + '" data-key="stageDate" /></div>' +
      '<div class="form-group stage-note"><label for="stageNote">Note (optional)</label><input type="text" id="stageNote" class="input" maxlength="' + MAX_HISTORY_NOTE + '" placeholder="e.g. Online test on Friday" data-key="stageNote" /></div>' +
      '<button type="submit" class="btn btn-primary">Save stage</button>' +
      '<span class="error-text stage-error" id="stageError" role="alert"></span>' +
    "</form>";

  const last = app.history.length - 1;
  const timeline = '<ol class="timeline">' + app.history.map((entry, index) =>
    '<li class="tl-item' + (index === last ? " tl-current" : "") + '">' +
      '<span class="tl-dot" aria-hidden="true"></span>' +
      '<div class="tl-body"><div class="tl-head">' + statusBadge(entry.status) + (index === last ? ' <span class="chip">Current</span>' : "") + "</div>" +
      '<div class="tl-date">' + (entry.date ? formatDate(entry.date) : "Date not recorded") + "</div>" +
      (entry.note ? '<div class="tl-note">' + escapeHtml(entry.note) + "</div>" : "") + "</div></li>"
  ).join("") + "</ol>";

  return (
    '<h3 class="detail-h">Stage</h3>' + stepper +
    '<h3 class="detail-h">Update stage</h3>' + form +
    '<h3 class="detail-h">History <span class="count-pill">' + app.history.length + "</span></h3>" + timeline
  );
}

function submitStageForm() {
  const app = applications.find(item => item.id === detailId);
  if (!app) return;
  const result = applyStageChange(app, $("stageSelect").value, $("stageDate").value, $("stageNote").value, getTodayIso());
  if (!result.ok) {
    $("stageError").textContent = result.error;
    return;
  }
  saveApplications();
  renderAll();
  showToast('Moved "' + app.name + '" to ' + app.status + ".");
  if (app.status === "Selected") celebrate();
}

/* ----- Documents tab ----- */

function documentsTabHtml(app) {
  const progress = getDocumentProgress(app);
  const warning = getDocumentWarning(app);

  const rows = app.documents.map(doc => {
    if (doc.id === editingDocId) {
      return '<li class="doc-item"><form class="doc-rename" data-did="' + doc.id + '" novalidate>' +
        '<input type="text" class="input" id="docRenameInput" maxlength="' + MAX_DOC_LENGTH + '" value="' + escapeHtml(doc.label) + '" aria-label="New name for ' + escapeHtml(doc.label) + '" data-key="rename" />' +
        '<button type="submit" class="btn btn-primary btn-small">Save</button>' +
        '<button type="button" class="btn btn-secondary btn-small" data-dact="cancel-rename">Cancel</button>' +
        '<span class="error-text" id="docRenameError" role="alert"></span></form></li>';
    }
    return '<li class="doc-item' + (doc.done ? " doc-done" : "") + '">' +
      '<label class="doc-check"><input type="checkbox" data-dact="toggle-doc" data-did="' + doc.id + '" data-key="doc-' + doc.id + '"' + (doc.done ? " checked" : "") + " />" +
      '<span class="doc-name">' + escapeHtml(doc.label) + '</span><span class="doc-state">' + (doc.done ? "Ready" : "Pending") + "</span></label>" +
      '<div class="doc-actions">' +
      '<button type="button" class="btn btn-secondary btn-small" data-dact="rename-doc" data-did="' + doc.id + '" data-key="rename-' + doc.id + '" aria-label="Rename ' + escapeHtml(doc.label) + '">Rename</button>' +
      '<button type="button" class="btn btn-secondary btn-small" data-dact="remove-doc" data-did="' + doc.id + '" aria-label="Remove ' + escapeHtml(doc.label) + '">Remove</button>' +
      "</div></li>";
  }).join("");

  return (
    '<div class="doc-progress"><strong>' + progress.done + "/" + progress.total + ' documents ready</strong><span class="panel-hint">' + progress.percent + "%</span></div>" +
    '<div class="progress" role="progressbar" aria-label="Document checklist progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + progress.percent + '">' +
      '<span class="progress-fill" style="width:' + progress.percent + '%"></span></div>' +
    (warning ? '<p class="warn-box" role="status">' + escapeHtml(warning.text.charAt(0).toUpperCase() + warning.text.slice(1)) + ".</p>" : "") +
    (app.documents.length === 0
      ? '<p class="rem-empty">The checklist is empty. Add the documents you need below.</p>'
      : '<ul class="doc-list">' + rows + "</ul>") +
    '<form class="doc-add" id="docForm" novalidate>' +
      '<input type="text" class="input" id="docInput" maxlength="' + MAX_DOC_LENGTH + '" placeholder="Add a document, e.g. Passport copy" aria-label="New document name" data-key="docInput" />' +
      '<button type="submit" class="btn btn-primary btn-small">Add</button>' +
      '<span class="error-text" id="docError" role="alert"></span>' +
    "</form>" +
    '<p class="panel-hint">This is a checklist only. No files are uploaded or stored.</p>'
  );
}

function updateDocuments(change) {
  const app = applications.find(item => item.id === detailId);
  if (!app) return;
  change(app);
  saveApplications();
  renderAll();
}

/* ----- Interviews tab ----- */

function interviewsTabHtml(app) {
  const todayIso = getTodayIso();
  const entries = getAllInterviews([app]);
  return (
    '<div class="panel-header"><h3 class="detail-h">Interview rounds <span class="count-pill">' + entries.length + "</span></h3>" +
    '<button type="button" class="btn btn-primary btn-small" data-dact="add-interview" data-key="addInterview">Add interview</button></div>' +
    (entries.length === 0
      ? '<p class="rem-empty">No interviews recorded for this opportunity yet.</p>'
      : '<ul class="item-list">' + entries.map(entry => interviewItemHtml(entry, todayIso, "detail")).join("") + "</ul>")
  );
}

function handleDetailClick(event) {
  const tab = event.target.closest(".tab");
  if (tab) { detailTab = tab.dataset.tab; editingDocId = null; renderDetail(); return; }

  const button = event.target.closest("[data-dact]");
  if (!button) return;
  const act = button.dataset.dact;
  const did = button.dataset.did;

  if (act === "rename-doc") { editingDocId = did; renderDetail(); const input = $("docRenameInput"); if (input) { input.focus(); input.select(); } }
  else if (act === "cancel-rename") { editingDocId = null; renderDetail(); }
  else if (act === "remove-doc") {
    updateDocuments(app => { app.documents = app.documents.filter(doc => doc.id !== did); });
    showToast("Document removed from the checklist.");
  } else if (act === "add-interview") {
    openInterviewForm(detailId, null, true);
  }
}

function handleDetailChange(event) {
  const box = event.target.closest('[data-dact="toggle-doc"]');
  if (!box) return;
  updateDocuments(app => {
    const doc = app.documents.find(item => item.id === box.dataset.did);
    if (doc) doc.done = box.checked;
  });
}

function handleDetailSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (form.id === "stageForm") { submitStageForm(); return; }

  const app = applications.find(item => item.id === detailId);
  if (!app) return;
  if (form.id === "docForm") {
    const label = $("docInput").value.trim();
    const error = validateDocumentLabel(app, label, null);
    if (error) { $("docError").textContent = error; $("docInput").classList.add("invalid"); return; }
    updateDocuments(a => { a.documents.push({ id: makeId("d"), label, done: false }); });
    showToast('Added "' + label + '" to the checklist.');
    const input = $("docInput"); if (input) input.focus();
  } else if (form.classList.contains("doc-rename")) {
    const label = $("docRenameInput").value.trim();
    const error = validateDocumentLabel(app, label, form.dataset.did);
    if (error) { $("docRenameError").textContent = error; $("docRenameInput").classList.add("invalid"); return; }
    editingDocId = null;
    updateDocuments(a => { a.documents.find(doc => doc.id === form.dataset.did).label = label; });
    showToast("Document renamed.");
  }
}


/* ---------- 7i. Interview form ---------- */

const INTERVIEW_FIELDS = {   // value key -> input id (its error message element is the id + "Error")
  date: "intDate", time: "intTime", round: "intRound", type: "intType", location: "intLocation",
  outcome: "intOutcome", prep: "intPrep", questions: "intQuestions", feedback: "intFeedback"
};

function clearInterviewErrors() {
  Object.values(INTERVIEW_FIELDS).concat("intApp").forEach(id => {
    $(id + "Error").textContent = "";
    $(id).classList.remove("invalid");
  });
}

/** Show the "also move to Interview stage" option only when adding to an earlier-stage opportunity. */
function updateInterviewMoveOption() {
  const app = applications.find(item => item.id === els.intApp.value);
  const canMove = !interviewContext.id && app && ["Not Applied", "Applied", "Assessment"].includes(app.status);
  els.intMoveRow.hidden = !canMove;
  if (!canMove) els.intMoveStage.checked = false;
}

/** Open the form to add an interview (interviewId null) or edit one. `lockApp` fixes the opportunity. */
function openInterviewForm(appId, interviewId, lockApp) {
  if (applications.length === 0) { showToast("Add an opportunity first.", "error"); return; }
  clearInterviewErrors();
  els.interviewForm.reset();
  returnFocusTo = returnFocusTo || document.activeElement;

  els.intApp.innerHTML = applications.slice().sort((a, b) => a.name.localeCompare(b.name)).map(app =>
    '<option value="' + app.id + '">' + escapeHtml(app.name) + " – " + escapeHtml(app.organisation) + "</option>"
  ).join("");
  els.intApp.value = appId && applications.some(app => app.id === appId) ? appId : applications[0].id;
  els.intApp.disabled = Boolean(lockApp || interviewId);
  interviewContext = { id: interviewId };

  const app = applications.find(item => item.id === els.intApp.value);
  const existing = interviewId ? app.interviews.find(item => item.id === interviewId) : null;
  els.interviewTitle.textContent = existing ? "Edit Interview" : "Add Interview";
  if (existing) {
    Object.keys(INTERVIEW_FIELDS).forEach(key => { $(INTERVIEW_FIELDS[key]).value = existing[key]; });
  } else {
    $("intRound").value = "Round " + (app.interviews.length + 1);
    $("intType").value = "Online";
    $("intOutcome").value = "Pending";
  }
  updateInterviewMoveOption();
  els.interviewOverlay.hidden = false;
  $("intDate").focus();
}

function closeInterviewForm() {
  els.interviewOverlay.hidden = true;
  interviewContext = null;
  if (els.detailOverlay.hidden && returnFocusTo && document.body.contains(returnFocusTo)) returnFocusTo.focus();
  if (els.detailOverlay.hidden) returnFocusTo = null;
}

function handleInterviewSubmit(event) {
  event.preventDefault();
  clearInterviewErrors();
  const app = applications.find(item => item.id === els.intApp.value);
  if (!app) { $("intAppError").textContent = "Choose an opportunity."; return; }

  const values = {};
  Object.keys(INTERVIEW_FIELDS).forEach(key => { values[key] = $(INTERVIEW_FIELDS[key]).value.trim(); });
  const errors = validateInterview(values, app, interviewContext.id);
  const keys = Object.keys(errors);
  if (keys.length > 0) {
    keys.forEach(key => {
      $(INTERVIEW_FIELDS[key] + "Error").textContent = errors[key];
      $(INTERVIEW_FIELDS[key]).classList.add("invalid");
    });
    showToast("Please fix the highlighted fields.", "error");
    return;
  }

  const editing = Boolean(interviewContext.id);
  if (editing) Object.assign(app.interviews.find(item => item.id === interviewContext.id), values);
  else app.interviews.push({ id: makeId("i"), ...values });

  let moved = false;
  if (!els.intMoveRow.hidden && els.intMoveStage.checked) {
    moved = applyStageChange(app, "Interview", getTodayIso(), "Interview scheduled: " + values.round, getTodayIso()).ok;
  }
  saveApplications();
  renderAll();
  closeInterviewForm();
  showToast((editing ? "Interview updated." : "Interview added.") + (moved ? " Moved to the Interview stage." : ""));
}

function askToDeleteInterview(appId, interviewId) {
  const app = applications.find(item => item.id === appId);
  const index = app ? app.interviews.findIndex(item => item.id === interviewId) : -1;
  if (index === -1) return;
  const removed = app.interviews[index];
  askConfirm('Delete "' + removed.round + '" for ' + app.name + "?", () => {
    app.interviews.splice(index, 1);
    saveApplications();
    renderAll();
    showToast("Interview deleted.", "", {
      label: "Undo",
      onClick: () => {
        if (!applications.includes(app) || app.interviews.some(item => item.id === removed.id)) return;
        app.interviews.splice(Math.min(index, app.interviews.length), 0, removed);
        saveApplications();
        renderAll();
        showToast("Interview restored.");
      }
    });
  }, { title: "Delete interview?" });
}


/* ---------- 8. Notifications (toasts) ---------- */

/**
 * Show a short message that disappears after a few seconds.
 * Optional third argument { label, onClick } adds a button (used for Undo).
 */
function showToast(message, type, action) {
  const toast = document.createElement("div");
  toast.className = "toast" + (type === "error" ? " toast-error" : "");

  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);

  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      toast.remove();
      action.onClick();
    });
    toast.appendChild(button);
  }

  els.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), action ? UNDO_SECONDS * 1000 : 3500);
}


/* ---------- 9. Add / Edit modal ---------- */

/** Clear all error messages and red borders in the form. */
function clearFormErrors() {
  ["name", "org", "type", "deadline", "link", "status", "priority", "notes"].forEach(key => {
    $(key + "Error").textContent = "";
    $(key + "Input").classList.remove("invalid");
  });
}

/** Show an error under one field. `key` is the field prefix, e.g. "name". */
function showFieldError(key, message) {
  $(key + "Error").textContent = message;
  $(key + "Input").classList.add("invalid");
}

/** Open the modal. Pass an application to edit it, or nothing to add a new one. */
function openModal(app) {
  clearFormErrors();
  els.form.reset();

  if (app) {
    editingId = app.id;
    els.modalTitle.textContent = "Edit Opportunity";
    els.nameInput.value = app.name;
    els.orgInput.value = app.organisation;
    els.typeInput.value = app.type;
    els.deadlineInput.value = app.deadline;
    els.linkInput.value = app.link || "";
    els.statusInput.value = app.status;
    els.priorityInput.value = getPriority(app);
    els.notesInput.value = app.notes || "";
  } else {
    editingId = null;
    els.modalTitle.textContent = "Add Opportunity";
  }

  els.modalOverlay.hidden = false;
  els.nameInput.focus();
}

function closeModal() {
  els.modalOverlay.hidden = true;
  editingId = null;
}

/** Read and tidy the values typed into the form. */
function readFormValues() {
  return {
    name: els.nameInput.value.trim(),
    organisation: els.orgInput.value.trim(),
    type: els.typeInput.value,
    deadline: els.deadlineInput.value,
    link: els.linkInput.value.trim(),
    status: els.statusInput.value,
    priority: els.priorityInput.value,
    notes: els.notesInput.value.trim()
  };
}

/** Handle the form being submitted (this is the Create / Update step of CRUD). */
function handleFormSubmit(event) {
  event.preventDefault(); // stop the page from reloading
  clearFormErrors();

  const values = readFormValues();
  const errors = validateForm(values);

  // Map error keys to the form field prefixes used in the HTML ids
  const fieldMap = { name: "name", organisation: "org", type: "type", deadline: "deadline", link: "link", status: "status", priority: "priority", notes: "notes" };
  const errorKeys = Object.keys(errors);

  if (errorKeys.length > 0) {
    errorKeys.forEach(key => showFieldError(fieldMap[key], errors[key]));
    showToast("Please fix the highlighted fields.", "error");
    return; // do not save invalid data
  }

  // Remember whether this save newly makes something "Selected" (for the celebration)
  const before = editingId ? applications.find(app => app.id === editingId) : null;
  const becameSelected = values.status === "Selected" && (!before || before.status !== "Selected");

  if (editingId) {
    // UPDATE: change the fields in place (keeps id, history, documents and interviews)
    const { status, ...fields } = values;
    Object.assign(before, fields);
    delete before.demo;      // an opportunity you edit is yours now, so "Clear demo data" keeps it
    // A different status is a stage change, so it is dated today and added to the history
    if (status !== before.status) applyStageChange(before, status, getTodayIso(), "", getTodayIso());
    showToast("Application updated successfully.");
  } else {
    // CREATE: add a new record at the end of the list
    applications.push(createRecord(values, getTodayIso()));
    showToast("Application added successfully.");
  }

  saveApplications();
  renderAll();
  els.form.reset();
  closeModal();
  if (becameSelected) celebrate();
}


/* ---------- 10. Delete with confirmation ---------- */

/** Show the confirm dialog. `onConfirm` runs only if the user accepts. */
function askConfirm(message, onConfirm, options) {
  confirmAction = onConfirm;
  els.confirmTitle.textContent = (options && options.title) || "Delete application?";
  els.confirmOkBtn.textContent = (options && options.label) || "Delete";
  els.confirmMessage.textContent = message;
  els.confirmOverlay.hidden = false;
  $("confirmCancelBtn").focus();
}

function closeConfirm() {
  els.confirmOverlay.hidden = true;
  confirmAction = null;
}

/** The confirm button: close the dialog, then do the confirmed action. */
function runConfirmed() {
  const action = confirmAction;
  closeConfirm();
  if (action) action();
}

function askToDelete(id) {
  const app = applications.find(item => item.id === id);
  if (!app) return;
  askConfirm('Delete "' + app.name + '" at ' + app.organisation + "? This cannot be undone.", () => deleteApplication(id));
}

/** DELETE: keep every record except the one being removed. */
function deleteApplication(id) {
  const index = applications.findIndex(app => app.id === id);
  if (index === -1) return;
  const removed = applications[index];
  applications = applications.filter(app => app.id !== id);
  if (detailId === id) closeDetail();
  saveApplications();
  renderAll();
  // Keep the removed record in memory for a few seconds so Undo can put it back
  showToast("Application deleted.", "", {
    label: "Undo",
    onClick: () => undoDelete(removed, index)
  });
}

/** Put a just-deleted record back where it was. */
function undoDelete(record, index) {
  if (!record || applications.some(app => app.id === record.id)) return;  // already back
  applications.splice(Math.min(index, applications.length), 0, record);
  saveApplications();
  renderAll();
  showToast('Restored "' + record.name + '".');
}


/* ---------- 11. Filters ---------- */

/** Reset search, filters and sorting to their defaults. */
function clearFilters() {
  els.searchInput.value = "";
  els.typeFilter.value = "all";
  els.statusFilter.value = "all";
  els.priorityFilter.value = "all";
  els.sortOrder.value = "asc";
  renderApplications();
}


/* ---------- 11b. CSV export and import (browser side) ---------- */

/** Download every saved opportunity as a .csv file. */
function exportCsv() {
  if (applications.length === 0) {
    showToast("Nothing to export yet. Add an opportunity first.", "error");
    return;
  }

  // "﻿" is a small marker that makes Excel on Windows read accents and symbols correctly
  const csvText = "﻿" + applicationsToCsv(applications);
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  // Create a temporary link, click it to start the download, then clean up
  const link = document.createElement("a");
  link.href = url;
  link.download = "opportunities-" + getTodayIso() + ".csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  showToast("Exported " + applications.length + (applications.length === 1 ? " opportunity" : " opportunities") + " to CSV.");
}

/** Download the upcoming deadlines as a calendar (.ics) file. */
function exportIcs() {
  const upcoming = getUpcomingDeadlines(applications);
  if (upcoming.length === 0) {
    showToast("No upcoming deadlines to add to a calendar.", "error");
    return;
  }

  // Time stamp such as 20261231T120000Z (required by the .ics format)
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const blob = new Blob([applicationsToIcs(upcoming, stamp)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "deadlines-" + getTodayIso() + ".ics";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  showToast("Saved " + upcoming.length + (upcoming.length === 1 ? " deadline" : " deadlines") + " to a calendar file. Open it to add them to your calendar.");
}

/** Show the import result dialog. `issues` is a list of text lines (may be empty). */
function showImportResult(title, summary, issues, helpText) {
  els.importTitle.textContent = title;
  els.importSummary.textContent = summary;

  els.importIssues.innerHTML = "";
  issues.forEach(line => {
    const item = document.createElement("li");
    item.textContent = line;          // textContent keeps the text safe
    els.importIssues.appendChild(item);
  });
  els.importIssues.hidden = issues.length === 0;

  els.importHelp.textContent = helpText || "";
  els.importHelp.hidden = !helpText;
  els.importOverlay.hidden = false;
}

function closeImportResult() {
  els.importOverlay.hidden = true;
}

const IMPORT_HELP =
  "Expected columns: Name, Organisation, Type (Internship, Scholarship, Fellowship or Other), " +
  "Deadline (YYYY-MM-DD), Status (Not Applied, Applied, Shortlisted, Selected or Rejected), " +
  "Link (optional) and Notes (optional). Use Export CSV to get a file in the right format.";

/** Read the chosen file, validate it, and add the valid rows to the saved list. */
function handleImportFile(file) {
  if (!file) return;

  if (file.size > MAX_IMPORT_BYTES) {
    showImportResult("Import failed", "That file is larger than 1 MB, so it was not imported.", [], "");
    return;
  }

  const reader = new FileReader();
  reader.onerror = () => {
    showImportResult("Import failed", "The file could not be read.", [], "");
  };
  reader.onload = () => {
    const result = importFromCsv(String(reader.result), applications);

    // The whole file is unusable (wrong columns, empty, broken quotes...): save nothing
    if (result.fatal) {
      showImportResult("Import failed", result.fatal + " Nothing was imported.", [], IMPORT_HELP);
      return;
    }

    // Otherwise add the valid rows and report anything that was skipped
    if (result.added.length > 0) {
      applications = applications.concat(result.added);
      saveApplications();
      renderAll();
    }

    const parts = [result.added.length + (result.added.length === 1 ? " opportunity imported" : " opportunities imported")];
    if (result.duplicates > 0) parts.push(result.duplicates + " skipped as already saved");
    if (result.skipped.length > 0) parts.push(result.skipped.length + " skipped because of errors");

    const issues = result.skipped.slice(0, 10).map(item => "Row " + item.row + ": " + item.reason);
    if (result.skipped.length > 10) issues.push("...and " + (result.skipped.length - 10) + " more rows with errors.");

    const title = result.added.length === 0 && result.skipped.length > 0 ? "Nothing imported" : "Import complete";
    showImportResult(title, parts.join(", ") + ".", issues, result.skipped.length > 0 ? IMPORT_HELP : "");
    if (result.added.length > 0) showToast("Imported " + result.added.length + " from CSV.");
  };
  reader.readAsText(file);
}


/* ---------- 12. Page views (navigation) ---------- */

/* The page has three views. Only one is visible at a time.
   Each name matches a section id in index.html and the data-view
   attribute on its sidebar link. */
const VIEW_TITLES = {
  dashboard: "Dashboard",
  applications: "Applications",
  board: "Board",
  interviews: "Interviews",
  analytics: "Analytics",
  calendar: "Calendar",
  deadlines: "Upcoming Deadlines"
};
const VIEW_NAMES = Object.keys(VIEW_TITLES);

/** Read the view name from the address bar (e.g. "#applications"). */
function getViewFromAddress() {
  return window.location.hash.replace("#", "");
}

/**
 * Show one view, hide the others, highlight the matching sidebar link
 * and update the page title. Unknown names fall back to the dashboard.
 */
function showView(viewName) {
  if (!VIEW_NAMES.includes(viewName)) viewName = "dashboard";

  // Show only the chosen section
  VIEW_NAMES.forEach(name => {
    $(name).hidden = name !== viewName;
  });

  // Highlight only the matching link
  els.sidebar.querySelectorAll(".nav-link").forEach(link => {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle("active", isActive);
    if (isActive) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  els.pageTitle.textContent = VIEW_TITLES[viewName];
  document.title = VIEW_TITLES[viewName] + " · Opportunity Tracker";
  window.scrollTo(0, 0); // start each view at the top
}

/** Switch view, remember it in the address bar, and close the mobile menu. */
function navigate(viewName) {
  showView(viewName);
  // Put the view name in the address bar so refresh and Back/Forward work
  try { history.pushState(null, "", "#" + viewName); } catch (error) { /* ignore */ }
  setSidebarOpen(false);
}

/** Open or close the slide-in sidebar (used on small screens). */
function setSidebarOpen(isOpen) {
  els.sidebar.classList.toggle("open", isOpen);
  els.backdrop.hidden = !isOpen;
  els.menuBtn.setAttribute("aria-expanded", String(isOpen));
  els.menuBtn.setAttribute("aria-label", isOpen ? "Close navigation menu" : "Open navigation menu");
}


/* ---------- 13. Event listeners ---------- */

/** Buttons inside lists are created dynamically, so one listener on the page checks which
 *  button (data-action) was clicked: edit, delete, details, edit-interview or delete-interview. */
function handleListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const id = button.dataset.id;
  const app = applications.find(item => item.id === id);
  const action = button.dataset.action;
  if (!app) return;

  if (action === "edit") {
    if (!els.detailOverlay.hidden) closeDetail();
    openModal(app);
  } else if (action === "delete") {
    askToDelete(id);
  } else if (action === "details") {
    openDetail(id, button.dataset.tab);
  } else if (action === "edit-interview") {
    openInterviewForm(id, button.dataset.iid, false);
  } else if (action === "delete-interview") {
    askToDeleteInterview(id, button.dataset.iid);
  }
}

/** Clicking a statistic card opens Applications already filtered to that status. */
function setupStatCards() {
  const open = (card) => {
    clearFilters();
    els.statusFilter.value = card.dataset.status === "all" ? "all" : card.dataset.status;
    renderApplications();
    navigate("applications");
  };
  document.querySelectorAll(".stat-card[data-status]").forEach(card => {
    card.addEventListener("click", () => open(card));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(card); }
    });
  });
}

/** Keyboard shortcuts: N = add an opportunity, / = jump to search. Ignored while typing or when a dialog is open. */
function setupShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if ([els.modalOverlay, els.detailOverlay, els.interviewOverlay, els.confirmOverlay, els.importOverlay].some(o => !o.hidden)) return;

    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      openModal();
    } else if (e.key === "/") {
      e.preventDefault();
      navigate("applications");
      els.searchInput.focus();
    }
  });
}

function setupEventListeners() {
  // "Add Opportunity" in the header
  $("addBtn").addEventListener("click", () => openModal());

  // Any other element marked data-add (empty-state buttons) also opens the form
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-add]")) openModal();
  });

  // Buttons marked data-goto jump to another view (e.g. "View all")
  document.addEventListener("click", (event) => {
    const goto = event.target.closest("[data-goto]");
    if (goto) navigate(goto.dataset.goto);
  });

  // Close the modal
  $("closeModalBtn").addEventListener("click", closeModal);
  $("cancelBtn").addEventListener("click", closeModal);
  els.modalOverlay.addEventListener("click", (e) => {
    if (e.target === els.modalOverlay) closeModal(); // click on the dark backdrop
  });

  // Form submit
  els.form.addEventListener("submit", handleFormSubmit);

  // Delete confirmation
  $("confirmCancelBtn").addEventListener("click", closeConfirm);
  $("confirmDeleteBtn").addEventListener("click", runConfirmed);
  els.confirmOverlay.addEventListener("click", (e) => {
    if (e.target === els.confirmOverlay) closeConfirm();
  });

  // CSV: Export downloads a file; Import opens the file picker, then reads the chosen file
  $("exportBtn").addEventListener("click", exportCsv);
  $("importBtn").addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", () => {
    handleImportFile(els.importFile.files[0]);
    els.importFile.value = "";   // allow choosing the same file again later
  });
  $("importCloseBtn").addEventListener("click", closeImportResult);
  els.importOverlay.addEventListener("click", (e) => {
    if (e.target === els.importOverlay) closeImportResult();
  });

  // Board drag-and-drop, theme toggle
  setupBoardEvents();
  setupCalendarEvents();
  document.addEventListener("click", handleListClick);       // Details / Edit / Delete buttons anywhere on the page
  setupStatCards();
  setupShortcuts();
  els.icsBtn.addEventListener("click", exportIcs);
  els.themeBtn.addEventListener("click", toggleTheme);

  // Details dialog (tabs, stage form, checklist) and interview form
  $("detailCloseBtn").addEventListener("click", closeDetail);
  $("detailDoneBtn").addEventListener("click", closeDetail);
  $("detailEditBtn").addEventListener("click", () => {
    const app = applications.find(item => item.id === detailId);
    closeDetail();
    if (app) openModal(app);
  });
  els.detailOverlay.addEventListener("click", (e) => { if (e.target === els.detailOverlay) closeDetail(); });
  document.querySelector(".tabs").addEventListener("click", handleDetailClick);
  els.detailPanel.addEventListener("click", handleDetailClick);
  els.detailPanel.addEventListener("change", handleDetailChange);
  els.detailPanel.addEventListener("submit", handleDetailSubmit);
  els.addInterviewBtn.addEventListener("click", () => openInterviewForm(null, null, false));
  els.interviewForm.addEventListener("submit", handleInterviewSubmit);
  els.intApp.addEventListener("change", updateInterviewMoveOption);
  $("interviewCloseBtn").addEventListener("click", closeInterviewForm);
  $("interviewCancelBtn").addEventListener("click", closeInterviewForm);
  els.interviewOverlay.addEventListener("click", (e) => { if (e.target === els.interviewOverlay) closeInterviewForm(); });

  // Notifications: nothing is requested until this button is clicked
  els.notifyBtn.addEventListener("click", handleNotifyClick);
  $("clearDemoBtn").addEventListener("click", clearDemoData);

  // Search, filters and sort re-draw the list as the user types / selects
  els.searchInput.addEventListener("input", renderApplications);
  els.typeFilter.addEventListener("change", renderApplications);
  els.statusFilter.addEventListener("change", renderApplications);
  els.priorityFilter.addEventListener("change", renderApplications);
  els.sortOrder.addEventListener("change", renderApplications);
  $("clearFiltersBtn").addEventListener("click", clearFilters);
  $("noResultsClearBtn").addEventListener("click", clearFilters);

  // Escape key closes whichever dialog (or the mobile menu) is open
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!els.importOverlay.hidden) closeImportResult();
    else if (!els.confirmOverlay.hidden) closeConfirm();
    else if (!els.interviewOverlay.hidden) closeInterviewForm();
    else if (!els.detailOverlay.hidden) closeDetail();
    else if (!els.modalOverlay.hidden) closeModal();
    else setSidebarOpen(false);
  });

  // Sidebar links switch views
  els.sidebar.querySelectorAll(".nav-link").forEach(link => {
    link.addEventListener("click", (event) => {
      event.preventDefault(); // stop the browser from just scrolling to the anchor
      navigate(link.dataset.view);
    });
  });

  // Browser Back / Forward buttons: show the view named in the address bar
  window.addEventListener("popstate", () => showView(getViewFromAddress()));

  // Mobile menu button, dark backdrop, and growing the window past tablet size
  els.menuBtn.addEventListener("click", () => setSidebarOpen(!els.sidebar.classList.contains("open")));
  els.backdrop.addEventListener("click", () => setSidebarOpen(false));
  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) setSidebarOpen(false);
  });
}


/* ---------- 14. Safety check: is style.css loaded? ---------- */

/**
 * style.css defines a CSS variable called --teal. If we cannot read it,
 * the stylesheet did not load (wrong file name or wrong folder), so we
 * show a clear message instead of leaving a plain unstyled page.
 */
function checkStylesheetLoaded() {
  const teal = getComputedStyle(document.documentElement).getPropertyValue("--teal").trim();
  if (teal !== "") return;

  const banner = document.createElement("div");
  banner.id = "styleWarning";
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "background:#fee2e2;color:#7f1d1d;border:2px solid #dc2626;padding:14px 16px;" +
    "font:600 15px sans-serif;margin:12px;";
  banner.textContent =
    "Styling not loaded: make sure a file named style.css is in the SAME folder as index.html, then refresh.";
  document.body.prepend(banner);
}


/* ---------- 15. Start the app ---------- */

/**
 * First visit only: if LocalStorage never held a list and demo data was never offered before,
 * fill the app with the demo examples. A returning visitor (even one who deleted everything,
 * which leaves "[]" in storage) never gets demo data again, and existing data is never touched.
 */
function seedDemoIfFirstVisit() {
  if (!firstVisit || !storageAvailable) return;
  try {
    if (localStorage.getItem(SEEDED_KEY) !== null) return;
    localStorage.setItem(SEEDED_KEY, getTodayIso());
  } catch (error) {
    return;
  }
  applications = buildDemoOpportunities(getToday());
  saveApplications();
}

/** Add one <option> per value to a select. */
function fillSelect(select, values) {
  values.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
}

function init() {
  checkStylesheetLoaded();
  updateThemeButton();                 // theme itself was already applied by the small script in index.html
  fillSelect(els.statusFilter, STATUSES);
  fillSelect(els.statusInput, STATUSES);
  fillSelect(document.getElementById("intType"), INTERVIEW_TYPES);
  fillSelect(document.getElementById("intOutcome"), INTERVIEW_OUTCOMES);
  applications = loadApplications();   // load saved data first (old records are upgraded here)
  notifyPrefs = loadNotifyPrefs();
  seedDemoIfFirstVisit();
  const now = getToday();               // the calendar starts on the current month
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  setupEventListeners();
  renderAll();
  showView(getViewFromAddress());      // open the view named in the address bar (default: dashboard)
  // Turn on CSS fade effects only now, so the first paint has no highlight animation
  requestAnimationFrame(() => document.body.classList.add("ready"));
  setInterval(tickHero, 1000);         // keeps the countdown moving
  if (migratedOnLoad) {
    saveApplications();                // write the upgraded records back once (a raw backup was kept)
    showToast("Your saved opportunities were upgraded to the new format. A backup copy was kept in this browser.");
  }
  if (corruptOnLoad) {
    showToast("Saved data could not be read, so the list started empty. The unreadable data was kept in this browser.", "error");
  }
  checkNotifications();
  setInterval(checkNotifications, NOTIFY_CHECK_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { renderAll(); checkNotifications(); } });
  if (!storageAvailable) {
    showToast("Browser storage is unavailable. Your data will not be saved.", "error");
  }
}

if (hasDom) {
  init();
}

// Lets the pure logic be tested from Node without a browser (ignored in the browser)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseDate, daysUntil, formatDate, isRealDate, isValidUrl, validateForm,
    calculateStats, getVisibleApplications, getUpcomingDeadlines, getOverdueDeadlines,
    getRecentApplications, getDeadlineIndicator, getDeadlineUrgency, daysLabel, isTracked,
    countDueWithin, getNextDeadline, getCountdownParts, getStatusSegments, getPriority, buildCalendarMonth,
    applicationsToIcs, applicationsToCsv, parseCsv, importFromCsv,
    normalizeRecord, createRecord, buildDemoOpportunities, applyStageChange, getStepperSteps, hasSubmitted, hasBeenShortlisted, getSubmissionDate,
    getDocumentProgress, validateDocumentLabel, getDocumentWarning, validateInterview, getAllInterviews, splitInterviews,
    getReminderBuckets, getNotificationStep, getNotificationsDue, getAnalytics, formatRate,
    STATUSES, TRACKED_STATUSES, DEFAULT_DOCUMENTS
  };
}
