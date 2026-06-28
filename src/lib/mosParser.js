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
// ═══════════════════════════════════════════════════════════════════════════════

// Heading patterns that mark the START of the procedure/execution section.
// Designed to be INCLUSIVE: real MOS headings vary widely in phrasing and can
// include section numbers like "4." or "4.5" before the heading text, and the
// full line can be quite long when numbers + heading + subtitle are combined.
const SECTION_START_PATTERNS = [
  // English — common MOS heading variants
  /\bworking\s*procedure/i,
  /\bmethod\s*of\s*(execution|work|construction|installation|erection)/i,
  /\bexecution\s*(procedure|sequence|methodology|method|steps?|plan)/i,
  /\b(installation|construction|erection|implementation)\s*(procedure|method|sequence|steps?)/i,
  /\bsequence\s*of\s*(work|operation|execution|construction|activity)/i,
  /\bwork\s*(procedure|sequence|method|execution)/i,
  /\bprocedure\s*of\s*(work|execution|installation)/i,
  /\bconstruction\s*(method|sequence|procedure)/i,
  /\binstallation\s*(method|sequence|procedure)/i,
  /^\s*[\d\.]*\s*(procedure|methodology)\s*$/i,  // bare "Procedure" or "Methodology" possibly with number

  // Arabic — full coverage of Egyptian engineering MOS variants
  /خطوات\s*(ال)?تنفيذ/,
  /مراحل\s*(ال)?تنفيذ/,
  /منهجية\s*(ال)?تنفيذ/,
  /طريقة\s*(ال)?تنفيذ/,
  /(إ|ا)جراءات\s*(ال)?تنفيذ/,
  /(إ|ا)جراءات\s*(ال)?عمل/,
  /خطوات\s*(ال)?عمل/,
  /خطوات\s*تنفيذ\s*(ال)?(أ|ا)عمال/,
  /تسلسل\s*(ال)?تنفيذ/,
  /(ال)?تسلسل\s*(ال)?(زمني|تنفيذي)/,
  /وصف\s*(ال)?(أ|ا)عمال/,
  /أسلوب\s*(ال)?تنفيذ/,
  /طريقة\s*(ال)?عمل/,
];

// Lines that are definitely the DOCUMENT TITLE (not a section heading).
// We check the first 10 lines (generous — some MOS have long revision tables).
function isDocumentTitleLine(line, lineIndex) {
  if (lineIndex > 10) return false;
  const t = line.trim();
  return /^method\s*of\s*statement\s*$/i.test(t) ||
         /^(method\s*statement|MOS)\s*[-–:]/i.test(t) ||
         /^MOS[\s\-]/i.test(t) ||
         /^\s*مذكرة\s*منهجية\s*$/.test(t) ||
         /^\s*طريقة\s*(ال)?(أ|ا)داء\s*$/.test(t) ||
         /^\s*بيان\s*منهجية\s*(ال)?عمل\s*$/.test(t);
}

// Heading patterns that mark the END of the procedure section.
const SECTION_END_PATTERNS = [
  /\bquality\s*(control|assurance|plan)/i,
  /\b(health|safety)\s*(and|&)?\s*(safety|environment)/i,
  /\bhse\b/i,
  /\bsafety\s*(precautions?|plan|measures?|requirements?)/i,
  /\b(hold\s*points?|witness\s*points?|inspection\s*points?|itp)\b/i,
  /\breference(s|d\s*document)?\b/i,
  /\bappendi(x|ces)\b/i,
  /\battachment(s)?\b/i,
  /\bclosing\s*out\b/i,
  /\b(risk\s*assessment|hazard\s*(identification|analysis))\b/i,
  /\bpersonnel\s*(and|&)\s*(responsibilities|organization)\b/i,
  /\bresponsibilit(y|ies)\b/i,
  /\bequipment\s*(and|&)\s*(material|tool|resource)/i,
  /\bcompletion\s*(criteria|report|checklist)\b/i,
  /\b(material|equipment)\s*(list|requirement|description)\b/i,
  /\b(annex|appendices)\b/i,
  /\bscope\s*of\s*work\b/i,           // sometimes appears after procedure in certain templates

  // Arabic
  /(ال)?جودة/,
  /(ال)?سلامة/,
  /(ال)?صحة\s*و(ال)?سلامة/,
  /نقاط\s*(ال)?(توقف|فحص|تفتيش|الفحص)/,
  /(ال)?مراجع(ة)?/,
  /(ال)?ملحق(ات)?/,
  /(ال)?مرفقات/,
  /تقييم\s*(ال)?مخاطر/,
  /(ال)?مسؤوليات/,
  /(ال)?معدات\s*و(ال)?مواد/,
  /معايير\s*(ال)?(إ|ا)نجاز/,
];

function isHeadingLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  // Allow up to 150 chars — MOS headings with section numbers can be long
  // e.g. "4.5 Working Procedure / Execution Methodology and Installation Sequence"
  if (trimmed.length > 150) return false;
  // Long lines ending with typical sentence punctuation are prose, not headings
  if (/[;]\s*$/.test(trimmed) && trimmed.length > 80) return false;
  return true;
}

// Strip leading section numbers like "4.", "4.1", "4.1.2" from a heading line
// so the pattern matching focuses on the actual heading words
function stripSectionNumber(line) {
  return line.replace(/^\s*\d+(\.\d+)*\s*\.?\s*/, "").trim();
}

function findSectionBounds(lines) {
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isHeadingLine(line)) continue;
    if (isDocumentTitleLine(line, i)) continue;

    // Test both the raw line and the version with section numbers stripped,
    // because "4.3 Working Procedure" should match "working procedure" pattern
    const stripped = stripSectionNumber(line);
    const testLine = stripped || line;

    if (SECTION_START_PATTERNS.some(p => p.test(line) || p.test(testLine))) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!isHeadingLine(line)) continue;
    const stripped = stripSectionNumber(line);
    const testLine = stripped || line;
    if (SECTION_END_PATTERNS.some(p => p.test(line) || p.test(testLine))) {
      endIdx = i;
      break;
    }
  }

  return { startIdx, endIdx };
}

const STEP_PATTERNS = [
  /^\s*step\s*(?:no\.?)?\s*(\d{1,3})\s*[:\-\.\)]?\s*(.+)$/i,
  /^\s*(\d{1,3})\s*[\.\)]\s+(.{4,})$/,
  /^\s*(\d{1,3}\.\d{1,3})\s+(.{4,})$/,
  /^\s*([٠-٩]{1,3})\s*[\.\)]\s+(.{4,})$/,
];

// Phase heading patterns — "Phase 1", "Phase I", "المرحلة الأولى", etc.
// These are matched to extract the PHASE TITLE; sub-items below become the desc.
const PHASE_PATTERN = /^\s*phase\s*(\d{1,2}|I{1,3}V?|VI{0,3}|IX|X{0,2})\s*[:\-–]?\s*(.*)?$/i;
const ARABIC_PHASE_PATTERN = /^\s*(المرحلة|مرحلة)\s*([\d٠-٩]+|الأولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|الأول|الثاني|الثالث)\s*[:\-–]?\s*(.*)?$/;

// Sub-item patterns under a phase: "- text", "• text", "* text", "a. text"
const SUBITEM_PATTERN = /^\s*(?:[-–•*]|[a-zA-Z]\)\.?)\s+(.{3,})$/;

function detectPhases(lines) {
  // Try to extract Phase-structured content.
  // Each Phase becomes a step; its sub-items are concatenated into the desc.
  const phases = [];
  let currentPhase = null;
  let subItems = [];

  const flushPhase = () => {
    if (!currentPhase) return;
    phases.push({
      title: currentPhase,
      desc: subItems.length > 0 ? subItems.join("\n") : "",
    });
    currentPhase = null;
    subItems = [];
  };

  for (const line of lines) {
    // Check if this line is a Phase heading
    const phaseMatch = line.match(PHASE_PATTERN) || line.match(ARABIC_PHASE_PATTERN);
    if (phaseMatch) {
      flushPhase();
      // Build phase title: "Phase 1: Title text" or just "Phase 1" if no trailing text
      const phaseLabel = line.match(PHASE_PATTERN)
        ? `Phase ${phaseMatch[1]}${phaseMatch[2] ? ": " + phaseMatch[2].trim() : ""}`
        : `${phaseMatch[1]} ${phaseMatch[2]}${phaseMatch[3] ? ": " + phaseMatch[3].trim() : ""}`;
      currentPhase = phaseLabel.replace(/\s+/g, " ").trim();
      continue;
    }

    if (currentPhase) {
      // Sub-item directly under the current phase
      const subMatch = line.match(SUBITEM_PATTERN);
      if (subMatch) {
        subItems.push("• " + subMatch[1].trim());
        continue;
      }
      // A numbered sub-item like "1. text" under the phase
      const numMatch = line.match(/^\s*\d+[\.\)]\s+(.{4,})$/) || line.match(/^\s*[٠-٩]+[\.\)]\s+(.{4,})$/);
      if (numMatch) {
        subItems.push("• " + numMatch[1].trim());
        continue;
      }
      // Plain continuation text (not too long → it's a sub-step description)
      if (line.length < 150 && !/^[A-Z\u0600-\u06FF]{2,}/.test(line)) {
        // Might be inline description for the phase itself — skip adding to sub-items
        // to avoid pulling in prose paragraphs, but short enough lines are sub-steps
        if (line.length < 80 && line.length > 6) {
          subItems.push("• " + line.trim());
        }
      }
    }
  }
  flushPhase();
  return phases;
}

const NOISE_PATTERNS = [
  /^(page|صفحة)\s*\d+/i,
  /^(table of contents|محتويات)/i,
  /^(revision|rev\.?)\s*[:\-]/i,
  /^(document|doc)\s*(no\.?|number)/i,
  /^\s*صفحة\s*[\d٠-٩]+\s*(من|of)\s*[\d٠-٩]+/i,
  /^\s*(الإصدار|الاصدار|رقم\s*المراجعة)\s*[:\-]/i,
  /^\s*$/,
];

function isNoise(line) {
  return NOISE_PATTERNS.some(p => p.test(line.trim()));
}

export function detectSteps(rawText, maxSteps = 40) {
  const allLines = rawText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !isNoise(l));

  const bounds = findSectionBounds(allLines);
  const sectionFound = bounds !== null;
  const lines = sectionFound
    ? allLines.slice(bounds.startIdx + 1, bounds.endIdx)
    : allLines;

  // ── Strategy 1: Try numbered steps first (the common case) ──────────────────
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
    if (title.length < 4 || title.length > 160) continue;
    if (/^[\d\.\-\s]+$/.test(title)) continue;
    candidates.push({ title, desc: "" });
  }

  // De-duplicate consecutive identical matches (PDF line-wrap artifacts)
  const deduped = [];
  for (const c of candidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.title === c.title) continue;
    deduped.push(c);
  }

  if (deduped.length >= 2) {
    // Found enough numbered steps — use them
    return {
      steps: deduped.slice(0, maxSteps),
      sectionFound,
    };
  }

  // ── Strategy 2: Fall back to Phase-based detection ──────────────────────────
  const phases = detectPhases(lines);
  if (phases.length >= 1) {
    return {
      steps: phases.slice(0, maxSteps),
      sectionFound,
    };
  }

  // ── Nothing found ────────────────────────────────────────────────────────────
  return { steps: [], sectionFound };
}

export async function parseStepsFromFile(file) {
  const text = await extractText(file);
  const { steps, sectionFound } = detectSteps(text);
  return { text, steps, sectionFound };
}
