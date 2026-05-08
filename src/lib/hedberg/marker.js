// Edit-syntax marker parser. Recognizes `<<:::IDENT...:::IDENT` body
// shapes inside `<set>` content and routes by IDENT to one of six
// operations: NEW, PREPEND, APPEND, REPLACE, DELETE, SEARCH. Path- or
// identifier-flavored IDENTs (e.g. `OC_RIVERS.md`, mirroring how the
// packet itself renders entry bodies) are accepted and treated as
// REPLACE — the content between markers becomes the full new body.
//
// IDENT pattern: [A-Za-z_][A-Za-z0-9_./-]*. Covers normal identifiers
// AND path-shaped tokens. Operation detection is strict: IDENT must
// match `keyword[suffix]` where suffix is `[A-Za-z0-9_]*` (alphanumeric
// only, no dots/slashes/hyphens). Anything else is a non-keyword
// IDENT and routes to REPLACE.
//
// The trailing alphanumeric suffix on keyword IDENTs is opaque to
// routing — it exists so nested markers can disambiguate (same
// convention as bash heredoc `<<EOF1` vs `<<EOF`).
//
// Returns:
//   { ops: null,    error: null }   — no markers found, treat body as plain.
//   { ops: [{...}], error: null }   — well-formed marker(s).
//   { ops: null,    error: "..." }  — parse failure (lone SEARCH, unclosed).
//
// Where each op is:
//   { op: "new" | "prepend" | "append" | "replace" | "delete", content }
//   { op: "search_replace", search, replace }
//
// SEARCH must be immediately followed by REPLACE; the parser pairs
// adjacent SEARCH+REPLACE into one search_replace op. A lone SEARCH
// (no following REPLACE) is a parse error.

const KEYWORD_RE =
	/^(NEW|PREPEND|APPEND|REPLACE|DELETE|SEARCH)([A-Za-z0-9_]*)$/;

const OPENER_RE = /<<:::([A-Za-z_][A-Za-z0-9_./-]*)/;

function operationFromIdent(ident) {
	const m = ident.match(KEYWORD_RE);
	if (m) return m[1].toLowerCase();
	// Non-keyword IDENT (path-flavored, identifier-flavored, anything
	// that isn't keyword-prefix-with-alphanumeric-suffix) — treat as
	// REPLACE. The content between markers becomes the full new body.
	return "replace";
}

function findOpener(body, startIdx) {
	const slice = body.slice(startIdx);
	const match = slice.match(OPENER_RE);
	if (!match) return null;
	return {
		ident: match[1],
		openerStart: startIdx + match.index,
		openerEnd: startIdx + match.index + match[0].length,
	};
}

function findCloser(body, startIdx, ident) {
	// Closer is `:::IDENT` followed by non-word boundary or end-of-input.
	// IDENT must match exactly; an inner `<<:::IDENT_NESTED ... :::IDENT_NESTED`
	// won't accidentally close the outer because IDENT differs.
	const escIdent = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`:::${escIdent}(?![A-Za-z0-9_])`);
	const slice = body.slice(startIdx);
	const match = slice.match(re);
	if (!match) return null;
	return {
		closerStart: startIdx + match.index,
		closerEnd: startIdx + match.index + match[0].length,
	};
}

function trimMarkerNewlines(content) {
	let result = content;
	if (result.startsWith("\n")) result = result.slice(1);
	if (result.endsWith("\n")) result = result.slice(0, -1);
	return result;
}

export function parseMarkerBody(body) {
	// Cheap rejection — most `<set>` bodies don't contain markers.
	if (!body.includes("<<:::")) return { ops: null, error: null };

	const raw = [];
	let i = 0;
	while (i < body.length) {
		const opener = findOpener(body, i);
		if (!opener) break;
		const op = operationFromIdent(opener.ident);
		const closer = findCloser(body, opener.openerEnd, opener.ident);
		if (!closer) {
			return { ops: null, error: `unclosed <<:::${opener.ident}` };
		}
		const content = trimMarkerNewlines(
			body.slice(opener.openerEnd, closer.closerStart),
		);
		raw.push({ op, content });
		i = closer.closerEnd;
	}
	if (raw.length === 0) return { ops: null, error: null };

	// Pair adjacent SEARCH+REPLACE into one search_replace op.
	const ops = [];
	for (let j = 0; j < raw.length; j++) {
		const cur = raw[j];
		if (cur.op === "search") {
			const next = raw[j + 1];
			if (!next || next.op !== "replace") {
				return {
					ops: null,
					error: "SEARCH must be immediately followed by REPLACE",
				};
			}
			ops.push({
				op: "search_replace",
				search: cur.content,
				replace: next.content,
			});
			j++;
		} else {
			ops.push(cur);
		}
	}
	return { ops, error: null };
}
