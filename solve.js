// csv-reader-fast: a faster drop-in for csv-reader 1.0.0 (make.fun).
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for
// {text, header}: {columns, rows, errors}. The policy it implements, copied
// from the reference's own description:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled,
//     "" inside it one quote, and each CRLF or lone CR inside it is read as LF;
//     what follows its closing quote, up to the next comma or line break, is
//     appended to it as it stands (quote_junk, when the field ends); a quote that
//     never closes is read as a literal character and the text after it is read
//     again as an unquoted field (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings,
//     never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it (every record when header is false), each padded with ""
//     (short_row, with fields: its count) or cut (long_row, with extra: the cut
//     fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on
//     (every LF, CRLF and lone CR inside a quoted field counted), row its record's
//     index in rows (null for the header), in the order met, a field's quote_junk
//     when the field ends and a record's short_row or long_row when the record ends.
//
// Speed: the reference reads one character at a time and builds every field a
// character at a time. This reader instead slices fields out of the text
// (substring, a view, no copy) and jumps between delimiters with indexOf.
// A record whose line holds no quote and no stray CR is split in one native
// call. Only records with quotes or stray CRs are walked field by field, and
// even there a quoted field is taken as one slice unless it holds a doubled
// quote or a line break inside it.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `start` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Returns the field, how it ended, and how many characters were kept after `start`.
  function readUnquoted(start) {
    let value = start;
    let touched = start.length > 0;
    let fstart = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        if (touched) value += text.substring(fstart, pos);
        else value = text.substring(fstart, pos);
        pos += 1;
        return { value, ended: COMMA, added: value.length - start.length };
      }
      if (c === 10) {
        if (touched) value += text.substring(fstart, pos);
        else value = text.substring(fstart, pos);
        pos += 1;
        line += 1;
        return { value, ended: LINE_BREAK, added: value.length - start.length };
      }
      if (c === 13) {
        if (text.charCodeAt(pos + 1) === 10) {
          if (touched) value += text.substring(fstart, pos);
          else value = text.substring(fstart, pos);
          pos += 2;
          line += 1;
          return { value, ended: LINE_BREAK, added: value.length - start.length };
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (touched) value += text.substring(fstart, pos);
        else value = text.substring(fstart, pos);
        touched = true;
        pos += 1;
        fstart = pos;
        continue;
      }
      pos += 1;
    }
    if (touched) value += text.substring(fstart, pos);
    else value = text.substring(fstart, pos);
    return { value, ended: END, added: value.length - start.length };
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;

    // The end of this line's first segment: the next LF, or the end of the text.
    const le = text.indexOf('\n', pos);
    const segEnd = le === -1 ? n : le;
    const q = text.indexOf('"', pos);
    if (q !== -1 && q < segEnd) {
      // A quote on this segment: the record needs the field-by-field walk.
      parseSlow();
    } else {
      const cr = text.indexOf('\r', pos);
      // A CR is harmless only when it is the CRLF ending this segment.
      const crOk = cr === -1 || cr >= segEnd || (cr === segEnd - 1 && le !== -1);
      if (crOk) {
        // Fast path: this record is one plain line of unquoted fields.
        const contentEnd =
          le !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13 ? segEnd - 1 : segEnd;
        fields = text.substring(pos, contentEnd).split(',');
        pos = le === -1 ? n : le + 1;
        if (le !== -1) line += 1;
      } else {
        parseSlow();
      }
    }

    function parseSlow() {
      // Slow path: the record holds a quote or a stray CR; walk it field by field.
      fields = [];
      let field;
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) {
          // A quoted field whose opening quote is at pos.
          const open = pos;
          const openLine = line;
          pos += 1;
          // Find the closing quote: the next quote that is not doubled.
          let close = -1;
          let hasDouble = false;
          let i = pos;
          while (true) {
            const qq = text.indexOf('"', i);
            if (qq === -1) break;
            if (text.charCodeAt(qq + 1) === 34) {
              hasDouble = true;
              i = qq + 2;
              continue;
            }
            close = qq;
            break;
          }
          if (close === -1) {
            // The quote never closes: it is a literal character, and the text after it
            // is read again as unquoted.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            field = readUnquoted('"');
            fields.push(field.value);
            continue;
          }
          const nl = text.indexOf('\n', open + 1);
          const hasNL = nl !== -1 && nl < close;
          const crq = text.indexOf('\r', open + 1);
          const hasCR = crq !== -1 && crq < close;
          let value;
          if (!hasDouble && !hasNL && !hasCR) {
            value = text.substring(open + 1, close);
            pos = close + 1;
          } else {
            // Doubled quotes, or line breaks inside the quotes: build the value
            // segment by segment ("" one quote, CRLF or lone CR one LF).
            const parts = [];
            let seg = open + 1;
            let p = seg;
            while (p < close) {
              const c = text.charCodeAt(p);
              if (c === 34) {
                parts.push(text.substring(seg, p), '"');
                p += 2;
                seg = p;
                continue;
              }
              if (c === 13) {
                parts.push(text.substring(seg, p), '\n');
                line += 1;
                p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
                seg = p;
                continue;
              }
              if (c === 10) {
                parts.push(text.substring(seg, p), '\n');
                line += 1;
                p += 1;
                seg = p;
                continue;
              }
              p += 1;
            }
            parts.push(text.substring(seg, close));
            value = parts.join('');
            pos = close + 1;
          }
          if (pos >= n) {
            field = { value, ended: END };
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              field = { value, ended: COMMA };
            } else if (c === 10) {
              pos += 1;
              line += 1;
              field = { value, ended: LINE_BREAK };
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              field = { value, ended: LINE_BREAK };
            } else {
              // What follows the closing quote is appended as it stands, up to the
              // next comma or line break.
              field = readUnquoted(value);
              if (field.added > 0) {
                errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          }
          fields.push(field.value);
        } else {
          field = readUnquoted('');
          fields.push(field.value);
        }
      } while (field.ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
