// ═══════════════════════════════════════════════════════════════════════════════
// MOS DOCUMENT PARSER
// Extracts raw text from PDF / DOCX files, then detects a numbered sequence of
// execution steps using common MOS document patterns (numbered lists, "Step N",
// Arabic-numeral headings, lettered sub-items, etc).
// ═══════════════════════════════════════════════════════════════════════════════

import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import * as mammoth from "mammoth";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─── Extract raw text from a PDF File object ──────────────────────────────────
async function extractTextFromPDF(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pageTexts = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    // Preserve line breaks by grouping text items by their vertical (y) position
    const lines = [];
    let lastY = null;
    let currentLine = [];
    textContent.items.forEach(item => {
      const y = Math.round(item.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        lines.push(currentLine.join(" "));
        currentLine = [];
      }
      currentLine.push(item.str);
      lastY = y;
    });
    if (currentLine.length) lines.push(currentLine.join(" "));
    pageTexts.push(lines.join("\n"));
  }

  return pageTexts.join("\n\n");
}

// ─── Extract raw text from a DOCX File object ─────────────────────────────────
async function extractTextFromDOCX(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

// ─── Public: extract text from any supported file type ───────────────────────
export async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return extractTextFromPDF(file);
  if (name.endsWith(".docx")) return extractTextFromDOCX(file);
  if (name.endsWith(".txt")) return file.text();
  throw new Error("Unsupported file type. Please upload a PDF, DOCX, or TXT file.");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION ISOLATION
// MOS documents have many numbered things (scope items, safety precautions,
// referenced standards, revision history...). We must isolate ONLY the section
// that actually describes the execution sequence before looking for numbered
// steps inside it — otherwise we pick up numbers from unrelated sections.
// ═══════════════════════════════════════════════════════════════════════════════

// Heading patterns that mark the START of the procedure/execution section.
// Matched against a trimmed line, case-insensitively. Order doesn't matter here —
// whichever appears earliest in the document wins (see findSectionBounds below).
const SECTION_START_PATTERNS = [
  // NOTE: "method of statement" alone is usually the DOCUMENT TITLE, not a section
  // heading — so we deliberately do NOT match bare "Method of Statement" / "MOS".
  // We only match when it's clearly introducing execution content.
  /\bmethod\s*of\s*execution\b/i,
  /\bworking\s*procedure(s)?\b/i,
  /\bexecution\s*(procedure|sequence|methodology|steps?)\b/i,
  /\b(installation|construction|erection)\s*procedure\b/i,
  /\bsequence\s*of\s*(work|operations?|execution)\b/i,
  /\bprocedure\s*of\s*(work|execution)\b/i,
  /^\s*(\d{1,2}\.)?\s*procedure\s*$/i,                 // standalone numbered/bare "Procedure" heading
  /^\s*(\d{1,2}\.)?\s*methodology\s*$/i,

  // ── Arabic equivalents of "Working Procedure" / "Execution Steps" ──
  // Covers common real-world phrasing variants seen in Egyptian engineering
  // MOS documents (تنفيذ = execution, عمل/أعمال = work, خطوات/مراحل = steps/stages,
  // اجراءات/إجراءات = procedures, منهجية = methodology, طريقة = method).
  /خطوات\s*(ال)?تنفيذ/,                  // "خطوات التنفيذ" / "خطوات تنفيذ"
  /مراحل\s*(ال)?تنفيذ/,                  // "مراحل التنفيذ"
  /منهجية\s*(ال)?تنفيذ/,                 // "منهجية التنفيذ"
  /طريقة\s*(ال)?تنفيذ/,                  // "طريقة التنفيذ"
  /(إ|ا)جراءات\s*(ال)?تنفيذ/,            // "إجراءات التنفيذ" / "اجراءات التنفيذ"
  /(إ|ا)جراءات\s*(ال)?عمل/,              // "إجراءات العمل" / "اجراءات العمل"
  /خطوات\s*(ال)?عمل/,                    // "خطوات العمل"
  /خطوات\s*تنفيذ\s*(ال)?(أ|ا)عمال/,      // "خطوات تنفيذ الأعمال"
  /تسلسل\s*(ال)?تنفيذ/,                  // "تسلسل التنفيذ" (execution sequence)
  /(ال)?تسلسل\s*(ال)?(زمني|تنفيذي)/,     // "التسلسل الزمني/التنفيذي"
  /وصف\s*(ال)?(أ|ا)عمال/,                // "وصف الأعمال" (description of works — sometimes used as the procedure heading)
];

// A line consisting ONLY of the document title/type (e.g. "METHOD OF STATEMENT",
// "MOS-PF-INST-002") should never be treated as a section heading match, even if
// it superficially resembles one. We check this explicitly before testing the
// section patterns, since document titles commonly appear at the very top.
function isDocumentTitleLine(line, lineIndex) {
  if (lineIndex > 5) return false; // titles only appear near the top of the document
  const trimmed = line.trim().toLowerCase();
  return /^method\s*of\s*statement\s*$/i.test(trimmed) ||
         /^mos[\s\-]/i.test(trimmed) ||
         /^\s*مذكرة\s*منهجية\s*$/.test(trimmed) ||
         /^\s*طريقة\s*(ال)?(أ|ا)داء\s*$/.test(trimmed) ||      // "طريقة الأداء" as a bare title
         /^\s*بيان\s*منهجية\s*(ال)?عمل\s*$/.test(trimmed);     // "بيان منهجية العمل" as a bare title
}

// Heading patterns that mark the END of the procedure section — i.e. the START
// of the NEXT section, which means we should stop collecting step candidates.
const SECTION_END_PATTERNS = [
  /\bquality\s*(control|assurance)\b/i,
  /\b(health\s*,?\s*safety|hse|safety\s*precautions?)\b/i,
  /\b(hold\s*points?|inspection\s*points?|itp)\b/i,
  /\breference(s)?\b/i,
  /\bappendix\b/i,
  /\battachment(s)?\b/i,
  /\bclosing\s*out\b/i,
  /\bdocumentation\b/i,
  /\b(risk\s*assessment|method\s*statement\s*review)\b/i,
  /\bpersonnel\s*(and|&)\s*responsibilities\b/i,
  /\bequipment\s*(and|&)\s*materials?\b/i,             // often a section BEFORE procedure, but also appears after in some templates
  /\bcompletion\s*(criteria|checklist)\b/i,
  /^\s*(\d{1,2}\.)?\s*(annex|appendices)\b/i,

  // ── Arabic equivalents of the sections that typically follow the procedure ──
  /(ال)?جودة/,                              // "الجودة" / "ضبط الجودة" (quality control)
  /(ال)?سلامة/,                              // "السلامة" (safety)
  /(ال)?صحة\s*و(ال)?سلامة/,                  // "الصحة والسلامة المهنية"
  /نقاط\s*(ال)?(توقف|فحص|تفتيش)/,            // "نقاط التوقف / الفحص / التفتيش" (hold/inspection points)
  /(ال)?مراجع(ة)?/,                          // "المراجع" / "المراجعة" (references)
  /(ال)?ملحق(ات)?/,                          // "الملحق" / "الملحقات" (appendix/attachments)
  /(ال)?مرفقات/,                             // "المرفقات" (attachments)
  /تقييم\s*(ال)?مخاطر/,                      // "تقييم المخاطر" (risk assessment)
  /(ال)?مسؤوليات/,                           // "المسؤوليات" (responsibilities)
  /(ال)?معدات\s*و(ال)?مواد/,                 // "المعدات والمواد" (equipment & materials)
  /معايير\s*(ال)?(إ|ا)نجاز/,                 // "معايير الإنجاز" (completion criteria)
];

function isHeadingLine(line) {
  // Heuristic: a real section heading is short, often capitalized/numbered, and
  // doesn't end with punctuation typical of a sentence (avoids matching prose that
  // happens to contain the word "procedure" mid-paragraph).
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 90) return false;
  if (/[.;,]\s*$/.test(trimmed) && trimmed.length > 60) return false; // long sentence ending in punctuation = not a heading
  return true;
}

// Finds the [startLineIdx, endLineIdx) bounds of the procedure/execution section.
// Returns null if no clear start could be found (caller should fall back to
// scanning the whole document, with a warning).
function findSectionBounds(lines) {
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isHeadingLine(line)) continue;
    if (isDocumentTitleLine(line, i)) continue; // skip the document's own title/type line
    if (SECTION_START_PATTERNS.some(p => p.test(line))) {
      startIdx = i;
      break; // take the FIRST real match — MOS documents are linear, procedure section appears once
    }
  }

  if (startIdx === -1) return null;

  // Search forward from just after the heading for the next section's heading
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!isHeadingLine(line)) continue;
    if (SECTION_END_PATTERNS.some(p => p.test(line))) {
      endIdx = i;
      break;
    }
  }

  return { startIdx, endIdx };
}

// Ordered by specificity — more specific patterns are tried first so generic
// number-dot patterns don't accidentally swallow a "Step 3:" line, etc.
const STEP_PATTERNS = [
  // "Step 1:", "STEP 1 -", "Step No. 1"
  /^\s*step\s*(?:no\.?)?\s*(\d{1,3})\s*[:\-\.\)]?\s*(.+)$/i,
  // "1. Mobilization..." or "1) Mobilization..."
  /^\s*(\d{1,3})\s*[\.\)]\s+(.{4,})$/,
  // "1.1 Mobilization" (sub-numbered — still useful as a step)
  /^\s*(\d{1,3}\.\d{1,3})\s+(.{4,})$/,
  // Arabic-Indic digits "١. " or "١)"
  /^\s*([٠-٩]{1,3})\s*[\.\)]\s+(.{4,})$/,
];

// Lines that look like headers/noise and should never become a step
const NOISE_PATTERNS = [
  /^(page|صفحة)\s*\d+/i,
  /^(table of contents|محتويات)/i,
  /^(revision|rev\.?)\s*[:\-]/i,
  /^(document|doc)\s*(no\.?|number)/i,
  /^\s*صفحة\s*[\d٠-٩]+\s*(من|of)\s*[\d٠-٩]+/i,   // "صفحة 3 من 10"
  /^\s*(الإصدار|الاصدار|رقم\s*المراجعة)\s*[:\-]/i, // Arabic revision markers
  /^\s*$/,
];

function isNoise(line) {
  return NOISE_PATTERNS.some(p => p.test(line.trim()));
}

// ─── Public: detect a numbered step sequence from raw extracted text ─────────
// Isolates the Working Procedure / Execution section FIRST, then looks for
// numbered steps only within that section. Returns both the steps and metadata
// about whether a section boundary was actually found (so the UI can warn the
// user if we had to fall back to scanning the whole document).
export function detectSteps(rawText, maxSteps = 40) {
  const allLines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !isNoise(l));

  const bounds = findSectionBounds(allLines);
  const sectionFound = bounds !== null;
  const lines = sectionFound
    ? allLines.slice(bounds.startIdx + 1, bounds.endIdx) // exclude the heading line itself
    : allLines; // fallback: no clear section heading found, scan everything (less accurate)

  const candidates = [];

  for (const line of lines) {
    let matched = null;
    for (const pattern of STEP_PATTERNS) {
      const m = line.match(pattern);
      if (m) { matched = m; break; }
    }
    if (!matched) continue;

    const [, num, rest] = matched;
    const title = rest.trim().replace(/\s{2,}/g, " ");
    // Skip junk: too short, too long (likely a paragraph, not a heading), or just numbers
    if (title.length < 4 || title.length > 160) continue;
    if (/^[\d\.\-\s]+$/.test(title)) continue;

    candidates.push({ num, title });
  }

  // De-duplicate consecutive near-identical matches (common with PDF line-wrap artifacts)
  const deduped = [];
  for (const c of candidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.title === c.title) continue;
    deduped.push(c);
  }

  return {
    steps: deduped.slice(0, maxSteps).map(c => ({ title: c.title, desc: "" })),
    sectionFound,
  };
}

// ─── Public: full pipeline — file → extracted text → detected steps ──────────
export async function parseStepsFromFile(file) {
  const text = await extractText(file);
  const { steps, sectionFound } = detectSteps(text);
  return { text, steps, sectionFound };
}
