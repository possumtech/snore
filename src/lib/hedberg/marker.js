// Edit-syntax marker parser. Recognizes bash-heredoc-shaped
// `<<IDENT...IDENT` body markers inside `<set>` content and routes
// by IDENT prefix to one of six operations: NEW, PREPEND, APPEND,
// REPLACE, DELETE, SEARCH. Non-keyword IDENTs (e.g. `<<DOC`, `<<EOF`)
// route to REPLACE — the content between markers becomes the full
// new body.
//
// Grammar:
//   - Opener: `<<IDENT` where IDENT matches `[A-Z][A-Za-z0-9_]*`.
//     Boundary: preceded by start-of-body, whitespace, or `>` (so
//     `vec<<SEARCH` mid-token does not false-trigger).
//   - Closer: bare IDENT (matching opener exactly) with non-word
//     boundaries — preceded by whitespace/start, followed by
//     whitespace, `<`, `>`, or end.
//   - SEARCH must be immediately followed by REPLACE; the pair maps
//     to one search_replace op. Lone SEARCH is a parse error.
//   - Trailing alphanumeric suffix on the IDENT is opaque to routing
//     (`<<SEARCH1` and `<<SEARCH` both route to SEARCH). Suffix
//     exists so nested markers can disambiguate, same convention as
//     bash heredoc `<<EOF1` vs `<<EOF`. When a body literally
//     contains the bare keyword (`SEARCH` in prose or code), the
//     model picks a suffix so the inner literal does not prematurely
//     close the outer marker.
//
// The bare `<<IDENT` shape is visibly distinct from the engine's
// packet-rendering shape `<<:::IDENT` (see plugins/helpers.js). Edit
// syntax is bare-only: a body with `<<:::IDENT` does NOT match this
// parser and falls through to plain-body REPLACE with the markers
// preserved as literal content. Keep the two grammars distinct so
// model emissions and engine renderings can never be confused.
//
// Returns:
//   { ops: null,    error: null }   — no markers found, treat body as plain.
//   { ops: [{...}], error: null }   — well-formed marker(s).
//   { ops: null,    error: "..." }  — parse failure (lone SEARCH, unclosed).

const KEYWORD_RE =
	/^(NEW|PREPEND|APPEND|REPLACE|DELETE|SEARCH)([A-Za-z0-9_]*)$/;

// Opener: `<<IDENT` preceded by start-of-input, whitespace, or `>`.
const OPENER_RE = /(?<=^|[\s>])<<([A-Z][A-Za-z0-9_]*)/;

function operationFromIdent(ident) {
	const m = ident.match(KEYWORD_RE);
	if (m) return m[1].toLowerCase();
	// Non-keyword IDENT — treat as REPLACE.
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
	const escIdent = ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// Closer: bare IDENT with non-word boundaries — preceded by
	// whitespace or start-of-input, followed by whitespace, `<`, `>`,
	// or end. The trailing `<` lets the SEARCH closer adjoin an
	// immediately-following `<<REPLACE` opener (`SEARCH<<REPLACE`).
	const re = new RegExp(`(?<=^|\\s)${escIdent}(?=[\\s<>]|$)`);
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
	if (!/<<[A-Z]/.test(body)) return { ops: null, error: null };

	const raw = [];
	let i = 0;
	while (i < body.length) {
		const opener = findOpener(body, i);
		if (!opener) break;
		const op = operationFromIdent(opener.ident);
		const closer = findCloser(body, opener.openerEnd, opener.ident);
		if (!closer) {
			return { ops: null, error: `unclosed <<${opener.ident}` };
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
				return { ops: null, error: "lone SEARCH (no REPLACE)" };
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
