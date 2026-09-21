/**
 * User-supplied psychology source pack.
 *
 * The original files are preserved verbatim under knowledge/psychology/ and are
 * imported into Brain as immutable SourceDocument/SourceFragment records.
 * The extracted principles below are SOURCE_ONLY: they are not executable
 * runtime policies and must not be turned into runtime gates without a later,
 * explicit formalization step with provenance.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrainStore } from "../brain/store";
import { classifyLine, topicTags } from "../brain/classify";
import type { SourceDocument, SourceFragment, SourceRef } from "../brain/types";

export interface UserPsychologySourceDescriptor {
  file_id: string;
  filename: string;
  original_filename: string;
  sha256: string;
  total_lines: number;
  total_chars: number;
  truncated: boolean;
  truncation_note: string | null;
}

export interface UserPsychologySection {
  file_id: string;
  start_line: number;
  end_line: number;
  scope: "TABLE_OF_CONTENTS" | "MIXED" | "PSYCHOLOGY" | "RISK_AND_PSYCHOLOGY" | "MIXED_STRATEGY_MANAGEMENT";
  title: string;
}

export interface UserPsychologySourceRule {
  id: string;
  category: string;
  principle: string;
  source_refs: SourceRef[];
  formalization_status: "SOURCE_ONLY";
  runtime_status: "DISABLED";
  executable: false;
}

export const USER_PSYCHOLOGY_SOURCES: UserPsychologySourceDescriptor[] = [
  {
    file_id: "USER-PSY-1",
    filename: "USER_PSYCHOLOGY_1.txt",
    original_filename: "my phychology/1.txt",
    sha256: "31e52de9d6f6aa0c2ddd072b3986cbc4bb0fe64365ccc3dba852fbe0816eab25",
    total_lines: 2423,
    total_chars: 349991,
    truncated: true,
    truncation_note: "The supplied file is ~350k characters and ends mid-sentence/content. Content beyond the supplied bytes is absent and is not reconstructed.",
  },
  {
    file_id: "USER-PSY-2",
    filename: "USER_PSYCHOLOGY_2.txt",
    original_filename: "my phychology/2.txt",
    sha256: "485fa4f9afb49b43ba5fbe4a9b76fba72b157d1ab7a10c721638d5e18ec41e7a",
    total_lines: 640,
    total_chars: 90370,
    truncated: true,
    truncation_note: "The supplied file ends inside an unfinished source passage after a partial list of principles. No missing continuation is reconstructed.",
  },
];

export const USER_PSYCHOLOGY_SECTIONS: UserPsychologySection[] = [
  { file_id: "USER-PSY-1", start_line: 1, end_line: 108, scope: "TABLE_OF_CONTENTS", title: "مقدمه/فهرست مطالب" },
  { file_id: "USER-PSY-1", start_line: 109, end_line: 351, scope: "MIXED", title: "فصل اول معامله گری" },
  { file_id: "USER-PSY-1", start_line: 352, end_line: 1029, scope: "PSYCHOLOGY", title: "فصل دوم مراحل تبدیل به یک معامله گر موفق" },
  { file_id: "USER-PSY-1", start_line: 1030, end_line: 1083, scope: "PSYCHOLOGY", title: "فصل سوم شکست در معامله" },
  { file_id: "USER-PSY-1", start_line: 1084, end_line: 1249, scope: "RISK_AND_PSYCHOLOGY", title: "فصل چهارم مدیریت ریسک در معامله گری" },
  { file_id: "USER-PSY-1", start_line: 1250, end_line: 2265, scope: "PSYCHOLOGY", title: "فصل پنجم روان شناسی محیط معاملات" },
  { file_id: "USER-PSY-1", start_line: 2266, end_line: 2423, scope: "MIXED_STRATEGY_MANAGEMENT", title: "فصل ششم مدیریت معاملات" },
  { file_id: "USER-PSY-2", start_line: 1, end_line: 640, scope: "MIXED_STRATEGY_MANAGEMENT", title: "ادامه مطالب/استراتژی و مدیریت معاملات" },
];

export const USER_PSYCHOLOGY_SOURCE_RULES: UserPsychologySourceRule[] = [
  {
    id: "USER-PSY-PLAN-DISCIPLINE",
    category: "discipline",
    principle: "پایبندی به برنامه معاملاتی و تشخیص تفاوت میان پیروزی موجه و پیروزی ناموجه.",
    source_refs: [
      { file: "USER_PSYCHOLOGY_1.txt", start_line: 396, end_line: 403 },
      { file: "USER_PSYCHOLOGY_1.txt", start_line: 405, end_line: 424 },
    ],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-PATIENCE-NO-CHASE",
    category: "patience",
    principle: "صبر برای فرصت مناسب و پرهیز از تعقیب معامله پس از از دست رفتن نقطه مناسب ورود.",
    source_refs: [{ file: "USER_PSYCHOLOGY_1.txt", start_line: 639, end_line: 647 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-DISCIPLINE-SELF-CONTROL",
    category: "self_control",
    principle: "نظم، انضباط، خودکنترلی، تمرکز و مدیریت هیجان بخشی از عملکرد معامله‌گر هستند.",
    source_refs: [{ file: "USER_PSYCHOLOGY_1.txt", start_line: 650, end_line: 659 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-REALISTIC-EXPECTATIONS",
    category: "expectations",
    principle: "اهداف معاملاتی باید روشن، واقع‌بینانه و با داده‌های عینی و مستند پشتیبانی شوند؛ نتایج یک معامله یا دوره کوتاه نباید مبنای اصلاح اهداف قرار گیرد.",
    source_refs: [{ file: "USER_PSYCHOLOGY_1.txt", start_line: 163, end_line: 183 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-ACCEPT-UNCERTAINTY",
    category: "probabilistic_thinking",
    principle: "تفکر احتمالاتی مستلزم پذیرش ریسک، پذیرش عدم‌قطعیت و رها کردن نیاز به دانستن آینده یا درست بودن در هر معامله است.",
    source_refs: [{ file: "USER_PSYCHOLOGY_2.txt", start_line: 327, end_line: 344 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-MARKET-AS-IS",
    category: "objectivity",
    principle: "بازار باید آن‌گونه که هست درک شود، نه آن‌گونه که معامله‌گر می‌خواهد باشد؛ بخش قابل مشاهده منبع همچنین بر تمرکز در لحظه اکنون و معامله بدون ترس/خودشیفتگی تأکید می‌کند.",
    source_refs: [{ file: "USER_PSYCHOLOGY_2.txt", start_line: 636, end_line: 640 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-JOURNAL-REVIEW",
    category: "review",
    principle: "ژورنال و بازاندیشی برای ثبت معاملات، یادگیری از عملکرد و ارزیابی روند پیشرفت استفاده می‌شوند.",
    source_refs: [
      { file: "USER_PSYCHOLOGY_1.txt", start_line: 284, end_line: 306 },
      { file: "USER_PSYCHOLOGY_1.txt", start_line: 691, end_line: 713 },
    ],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-MINDFULNESS",
    category: "mindfulness",
    principle: "ذهن‌آگاهی به‌عنوان توجه به لحظه حال، مشاهده افکار و احساسات بدون درگیرشدن با آنها و کاهش واکنش‌های شتاب‌زده توصیف شده است.",
    source_refs: [{ file: "USER_PSYCHOLOGY_1.txt", start_line: 2185, end_line: 2219 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-STRESS-AWARENESS",
    category: "stress",
    principle: "استرس و هیجان‌های قوی بر عملکرد معاملاتی و تصمیم‌گیری اثر می‌گذارند و منبع بر آگاهی از این اثر و مدیریت آن تأکید می‌کند.",
    source_refs: [{ file: "USER_PSYCHOLOGY_1.txt", start_line: 2020, end_line: 2096 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-PRESENT-FOCUS",
    category: "attention",
    principle: "تمرکز و حضور در لحظه در مواجهه با بازار بخشی از چارچوب روان‌شناختی منبع است.",
    source_refs: [
      { file: "USER_PSYCHOLOGY_1.txt", start_line: 2191, end_line: 2208 },
      { file: "USER_PSYCHOLOGY_2.txt", start_line: 636, end_line: 640 },
    ],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
  {
    id: "USER-PSY-ERROR-LEARNING",
    category: "learning",
    principle: "اشتباهات به‌عنوان بخشی از روند یادگیری دیده می‌شوند و بازاندیشی برای جلوگیری از تکرار آنها توصیه شده است.",
    source_refs: [{ file: "USER_PSYCHOLOGY_1.txt", start_line: 2239, end_line: 2245 }],
    formalization_status: "SOURCE_ONLY",
    runtime_status: "DISABLED",
    executable: false,
  },
];

export function verifyUserPsychologySources(sourceDir = path.join(process.cwd(), "knowledge", "psychology")) {
  return USER_PSYCHOLOGY_SOURCES.map((descriptor) => {
    const full = path.join(sourceDir, descriptor.filename);
    if (!fs.existsSync(full)) throw new Error(`Missing user psychology source: ${full}`);
    const buf = fs.readFileSync(full);
    const text = buf.toString("utf8");
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const totalLines = text.split("\n").length;
    const totalChars = text.length;
    if (sha256 !== descriptor.sha256) {
      throw new Error(`User psychology source hash mismatch: ${descriptor.filename}`);
    }
    if (totalLines !== descriptor.total_lines || totalChars !== descriptor.total_chars) {
      throw new Error(`User psychology source size mismatch: ${descriptor.filename}`);
    }
    return { ...descriptor, path: full };
  });
}

export function ingestUserPsychologySources(
  store: BrainStore,
  sourceDir = path.join(process.cwd(), "knowledge", "psychology"),
): { documents: UserPsychologySourceDescriptor[]; fragments_written: number; lines_seen: number } {
  const verified = verifyUserPsychologySources(sourceDir);
  let fragmentsWritten = 0;
  let linesSeen = 0;

  for (const descriptor of verified) {
    const text = fs.readFileSync(path.join(sourceDir, descriptor.filename), "utf8");
    const lines = text.split("\n");
    const doc: SourceDocument = {
      file_id: descriptor.file_id,
      filename: descriptor.filename,
      source_hash: descriptor.sha256,
      source_version: "user-supplied-v1",
      immutable: true,
      total_lines: descriptor.total_lines,
      total_chars: descriptor.total_chars,
      ingestion_timestamp: Date.now(),
      truncated: descriptor.truncated,
      truncation_note: descriptor.truncation_note,
    };
    store.putDocument(doc);

    const frags: SourceFragment[] = lines.map((raw, i) => {
      const lineNo = i + 1;
      const classified = classifyLine(raw);
      linesSeen++;
      return {
        fragment_id: `FRG-${descriptor.file_id}-${lineNo}`,
        file_id: descriptor.file_id,
        start_line: lineNo,
        end_line: lineNo,
        raw_text: raw,
        topic_tags: ["user-psychology", ...topicTags(raw)],
        fragment_class: classified.cls,
        quarantined: classified.quarantine !== null,
        quarantine_reason: classified.quarantine,
      };
    });
    store.putFragments(frags);
    fragmentsWritten += frags.length;
  }

  return {
    documents: USER_PSYCHOLOGY_SOURCES,
    fragments_written: fragmentsWritten,
    lines_seen: linesSeen,
  };
}
