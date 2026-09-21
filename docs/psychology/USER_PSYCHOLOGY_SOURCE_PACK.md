# User Psychology Source Pack

## Status

The two user-supplied text files are preserved verbatim under `knowledge/psychology/`. They are imported into Brain as immutable `SourceDocument`/`SourceFragment` records. Source-only psychology principles are exposed for downstream formalization, but they are **not executable runtime policies by default**.

## Sources

- `USER_PSYCHOLOGY_1.txt` ← `my phychology/1.txt` — 2423 lines, 349991 chars, SHA-256 `31e52de9d6f6aa0c2ddd072b3986cbc4bb0fe64365ccc3dba852fbe0816eab25`
- `USER_PSYCHOLOGY_2.txt` ← `my phychology/2.txt` — 640 lines, 90370 chars, SHA-256 `485fa4f9afb49b43ba5fbe4a9b76fba72b157d1ab7a10c721638d5e18ec41e7a`

## Conservative extraction

The extraction below records principles explicitly supported by the supplied texts. It does not assign new numeric thresholds, blocks, penalties, medical diagnoses, or trading decisions that the source does not specify.

### `USER-PSY-PLAN-DISCIPLINE`
- Category: `discipline`
- Principle: پایبندی به برنامه معاملاتی و تشخیص تفاوت میان پیروزی موجه و پیروزی ناموجه.
- Sources: USER_PSYCHOLOGY_1.txt:396-403, USER_PSYCHOLOGY_1.txt:405-424
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-PATIENCE-NO-CHASE`
- Category: `patience`
- Principle: صبر برای فرصت مناسب و پرهیز از تعقیب معامله پس از از دست رفتن نقطه مناسب ورود.
- Sources: USER_PSYCHOLOGY_1.txt:639-647
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-DISCIPLINE-SELF-CONTROL`
- Category: `self_control`
- Principle: نظم، انضباط، خودکنترلی، تمرکز و مدیریت هیجان بخشی از عملکرد معامله‌گر هستند.
- Sources: USER_PSYCHOLOGY_1.txt:650-659
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-REALISTIC-EXPECTATIONS`
- Category: `expectations`
- Principle: اهداف معاملاتی باید روشن، واقع‌بینانه و با داده‌های عینی و مستند پشتیبانی شوند؛ نتایج یک معامله یا دوره کوتاه نباید مبنای اصلاح اهداف قرار گیرد.
- Sources: USER_PSYCHOLOGY_1.txt:163-183
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-ACCEPT-UNCERTAINTY`
- Category: `probabilistic_thinking`
- Principle: تفکر احتمالاتی مستلزم پذیرش ریسک، پذیرش عدم‌قطعیت و رها کردن نیاز به دانستن آینده یا درست بودن در هر معامله است.
- Sources: USER_PSYCHOLOGY_2.txt:327-344
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-MARKET-AS-IS`
- Category: `objectivity`
- Principle: بازار باید آن‌گونه که هست درک شود، نه آن‌گونه که معامله‌گر می‌خواهد باشد؛ منبع همچنین بر تمرکز در لحظه اکنون و معامله بدون ترس/خودشیفتگی تأکید می‌کند.
- Sources: USER_PSYCHOLOGY_2.txt:636-640
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-JOURNAL-REVIEW`
- Category: `review`
- Principle: ژورنال و بازاندیشی برای ثبت معاملات، یادگیری از عملکرد و ارزیابی روند پیشرفت استفاده می‌شوند.
- Sources: USER_PSYCHOLOGY_1.txt:284-306, USER_PSYCHOLOGY_1.txt:691-713
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-MINDFULNESS`
- Category: `mindfulness`
- Principle: ذهن‌آگاهی به‌عنوان توجه به لحظه حال، مشاهده افکار و احساسات بدون درگیرشدن با آنها و کاهش واکنش‌های شتاب‌زده توصیف شده است.
- Sources: USER_PSYCHOLOGY_1.txt:2185-2219
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-STRESS-AWARENESS`
- Category: `stress`
- Principle: استرس و هیجان‌های قوی بر عملکرد معاملاتی و تصمیم‌گیری اثر می‌گذارند و منبع بر آگاهی از این اثر و مدیریت آن تأکید می‌کند.
- Sources: USER_PSYCHOLOGY_1.txt:2020-2096
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-PRESENT-FOCUS`
- Category: `attention`
- Principle: تمرکز و حضور در لحظه در مواجهه با بازار بخشی از چارچوب روان‌شناختی منبع است.
- Sources: USER_PSYCHOLOGY_1.txt:2191-2208, USER_PSYCHOLOGY_2.txt:636-640
- Runtime status: `SOURCE_ONLY / DISABLED`

### `USER-PSY-ERROR-LEARNING`
- Category: `learning`
- Principle: اشتباهات به‌عنوان بخشی از روند یادگیری دیده می‌شوند و بازاندیشی برای جلوگیری از تکرار آنها توصیه شده است.
- Sources: USER_PSYCHOLOGY_1.txt:2239-2245
- Runtime status: `SOURCE_ONLY / DISABLED`


## Mixed-content handling

The supplied material contains psychology, risk, process, and strategy material. Strategy examples and technical trading recipes remain source material only; the psychology importer does not parse them into strategy runtime. This prevents accidental strategy invention from a psychology upload.

## Truncation

The two supplied files are imported exactly as provided. Both supplied files are preserved exactly as received and marked truncated where the supplied bytes end mid-content. The first file is ~350k characters and visibly ends mid-sentence; the second file ends inside an unfinished passage. Missing continuation is not reconstructed.

