---
name: humanities-writing
description: "Write humanities scholarship — journal articles, monograph chapters, critical editions, exhibition and catalogue texts. Chicago notes-bibliography and MLA styles, discursive footnotes, critical apparatus, archival and primary-source citation (repository/fonds/cote/folio), Zotero/CSL toolchain. Use for humanities writing where IMRAD structure and numeric citation styles do not apply."
category: writing
allowed-tools: [Read, Write, Edit, Bash]
---

# Humanities Writing

## Overview

Humanities scholarship does not follow IMRAD, and it does not cite like the sciences.
This skill covers the conventions that differ: argument-driven prose, Chicago
notes-bibliography and MLA styles, discursive footnotes, citation of primary and archival
sources, critical apparatus for editions, and the Zotero/CSL production toolchain.

Load this skill INSTEAD OF `scientific-writing` for humanities documents. Still load
`research-lookup` and `citation-management` for finding and verifying secondary literature.

## When to Use This Skill

- Journal articles, monograph chapters, essays in history, art history, literary studies,
  linguistics, philosophy, religious studies, archaeology, musicology, film & media studies
- Critical editions and textual commentary
- Exhibition catalogues, catalogue raisonné entries, collection notices
- Any document citing manuscripts, archives, artworks, or early printed books

## CRITICAL: Real Sources Only

Same zero-tolerance rule as all OpenScience writing: every citation must be a real,
verified publication or an identifiable primary source. Verify secondary literature through
`research-lookup` / `citation-management`. For primary sources, cite only materials whose
provenance was recorded during research (repository, fonds, shelfmark). Mark anything
unverifiable [CITATION NEEDED] — never fabricate a reference, a shelfmark, or a quotation.

## Structure: Argument, Not IMRAD

- Organize by ARGUMENT: an introduction that states the question, the historiographic
  stakes, and the thesis; body sections that each advance one step of the argument from
  evidence; a conclusion that states what has been established and what it changes.
- Sections carry meaningful titles (not "Methods"/"Results"). Many journals use no
  numbered headings at all — check the venue.
- Prose is continuous and discursive. No bullet points in the body. Evidence is quoted
  and analyzed in place, not summarized in tables.
- The literature review is woven into the argument (typically in the introduction and at
  each point of engagement), not a standalone section.
- First person singular is acceptable in most humanities venues ("I argue that…").

## Citation Style 1: Chicago Notes-Bibliography (default for history, art history)

Footnotes (not endnotes unless the venue requires) + final bibliography.

**Full note (first citation):**
> 1. Carlo Ginzburg, *The Cheese and the Worms: The Cosmos of a Sixteenth-Century Miller*, trans. John and Anne Tedeschi (Baltimore: Johns Hopkins University Press, 1980), 58–61.

**Short note (subsequent):**
> 2. Ginzburg, *Cheese and the Worms*, 74.

- Use the short form for repeat citations. "Ibid." is discouraged by Chicago 17th/18th ed.;
  prefer the short note. Never use "op. cit."
- Journal article note: First Last, "Article Title," *Journal* 12, no. 3 (2019): 45–67.
- Bibliography entry inverts the first author's name and drops page-of-citation:
  > Ginzburg, Carlo. *The Cheese and the Worms*. Translated by John and Anne Tedeschi. Baltimore: Johns Hopkins University Press, 1980.
- Discursive footnotes are normal and expected: qualifications, parallel evidence,
  historiographic asides belong in the notes, not the body. Keep each note purposeful.

## Citation Style 2: MLA (default for literary studies, some linguistics)

In-text parenthetical + Works Cited.

- In-text: (Author page) — e.g. (Auerbach 412). Add short title when citing several works
  by one author: (Auerbach, *Mimesis* 412).
- Works Cited entry:
  > Auerbach, Erich. *Mimesis: The Representation of Reality in Western Literature*. Translated by Willard R. Trask, Princeton UP, 2003.
- Verse quotation: use line numbers, not pages; mark line breaks with " / " for up to
  three lines, block-quote beyond.

Ask the user which style the venue requires; default to Chicago notes-bibliography when
unspecified. Other common house styles (e.g. journal-specific author-date variants) can be
produced from the same CSL data (see Toolchain).

## Citing Primary and Archival Sources

Cite archival material by its archival identity, never by URL alone. Canonical order:
repository (with city on first citation), fonds/collection, cote (shelfmark),
piece/folio, then a description and date.

**Archival document (note):**
> 3. Archives nationales, Paris (hereafter AN), F/17/13675, dossier 4, letter of the rector of Douai to the minister, 12 March 1882.

**Manuscript:**
> 4. Bibliothèque nationale de France, Paris (hereafter BnF), MS fr. 1584, fol. 27v.

- Folios cite recto/verso (fol. 27r, 27v; plural fols.), not pages.
- Establish the abbreviation on first use (AN, BnF, TNA, ASV…), then use it.
- Early printed books: author, title (original orthography), place and printer, year;
  add the copy consulted and its shelfmark when the specific copy matters, and signature
  references (sig. B2r) when there is no pagination.
- **Artworks**: artist, *Title*, date, medium, dimensions, holding institution, city,
  inventory number. E.g.: Albrecht Dürer, *Melencolia I*, 1514, engraving, 24 × 18.8 cm,
  Metropolitan Museum of Art, New York, 43.106.1.
- **Digital surrogates**: cite the physical original as above, then add the digitization
  ("digitized at <URL>, consulted 12 May 2026"). The source is the object, not the scan.
- **Interviews / oral sources**: interviewee, interviewer, date, place, recording/transcript
  location and access conditions. Respect any anonymization agreement.
- Quote sources in the original language in the body or the note, with translation; state
  once whose translations they are ("all translations are mine unless noted").

## Critical Apparatus (editions and textual commentary)

For critical editions, the apparatus records the constitution of the text:

- **Sigla**: assign each witness a siglum (A, B, V…); list them in the conspectus siglorum.
- **Apparatus entries**: lemma from the edited text, bracket ( ] ), then variants with
  their witnesses: `27 melancholia ] melencolia A : malincolia B`.
- Negative apparatus (only divergent witnesses cited) is standard; state the convention.
- Editorial sigla in the text: ⟨ ⟩ editorial addition, [ ] editorial deletion or lacuna,
  † † cruces for corrupt passages, *** lacuna. Use them consistently and gloss them once.
- Keep three layers apart: the edited text, the apparatus criticus (variants), and the
  commentary (interpretation). Never mix interpretation into the apparatus.
- For TEI-encoded editions, the apparatus lives in `<app>`/`<rdg>` elements; the printed
  apparatus is generated from it, not written separately.

## Toolchain: Zotero, CSL, Pandoc, LaTeX

Prefer a CSL-based pipeline — BibTeX's native styles cannot produce correct Chicago
notes or MLA.

**Pandoc + CSL (recommended default):**
1. Keep references as CSL JSON (Zotero export: "CSL JSON") or BibTeX with `--citeproc`.
2. Fetch the venue's CSL style from the Zotero Style Repository
   (e.g. `chicago-note-bibliography.csl`, `modern-language-association.csl`).
3. Build:
   ```bash
   pandoc article.md --citeproc --bibliography refs.json \
     --csl chicago-note-bibliography.csl -o article.docx   # or .pdf, .tex
   ```
4. Cite in the source as `[@ginzburg1980, 58-61]`; pandoc renders footnotes and
   bibliography in the chosen style. Discursive notes stay as regular footnotes `^[...]`.

**LaTeX (when the venue requires it):** use `biblatex` with the `biblatex-chicago`
package (`\usepackage[notes]{biblatex-chicago}`) — NOT natbib — and compile with `biber`.
For editions, use `reledmac` for the apparatus.

**Word .docx targets** (common for humanities journals): the pandoc pipeline above
produces submissible .docx with real footnotes; check the venue's template afterwards.

Many humanities journals do NOT use LaTeX — ask, or check the venue's submission
guidelines before choosing the output format.

## Workflow

1. **Venue & style** — identify the target venue, its citation style, word limit, and
   format (.docx more often than LaTeX). Fetch the matching CSL style.
2. **Argument skeleton** — thesis, section-by-section argument plan, and the evidence
   (primary sources, with provenance) each section rests on. Verify every secondary
   reference now (`research-lookup`, `citation-management`).
3. **Draft** — continuous prose, evidence quoted and analyzed in place, notes written as
   you go. Keep say/imply/infer distinctions from the research phase.
4. **Apparatus & figures** — for editions, build the apparatus; for art history, prepare
   figure list with full credits (artist, title, date, institution, inventory number,
   image rights).
5. **Compile** — pandoc/CSL or biblatex-chicago build; verify notes, bibliography
   formatting, and that every note has a bibliography entry (and vice versa).
6. **Review** — load `peer-review`; additionally check: quotations against sources,
   translations attributed, archival cotes exact, no anachronism in terminology, rights
   cleared for every reproduced image.

## Final Checklist

- [ ] Style matches venue (Chicago NB / MLA / house style); one style throughout
- [ ] Every quotation verified against the source; translations attributed
- [ ] Every archival citation carries repository, fonds, cote, folio
- [ ] Artworks cited with institution and inventory number; image rights cleared
- [ ] Notes and bibliography correspond exactly
- [ ] No IMRAD residue: no "Methods"/"Results" headings, no bullet points in body
- [ ] For editions: sigla consistent, apparatus separate from commentary
